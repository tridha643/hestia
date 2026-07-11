import { HestiaError, type Endpoint, type StackRecord } from "@hestia/core";

export interface ResolvedEndpointSelection {
  endpoint: Endpoint;
  workload: string;
  binding: string;
}

function fromBinding(
  record: StackRecord,
  workload: string,
  bindingSelector: string,
): ResolvedEndpointSelection | null {
  const service = record.services.find((candidate) => candidate.name === workload);
  const binding = service?.bindings?.find((candidate) =>
    `${candidate.target}/${candidate.protocol}` === bindingSelector
  );
  if (binding === undefined) return null;
  const configured = record.endpoints.find((endpoint) =>
    (endpoint.workload ?? endpoint.name) === workload && endpoint.binding === bindingSelector
  );
  return {
    workload,
    binding: bindingSelector,
    endpoint: configured ?? {
      name: `${workload}:${bindingSelector}`,
      workload,
      binding: bindingSelector,
      kind: binding.protocol === "udp" ? "udp" : "tcp",
      host: "127.0.0.1",
      port: binding.publishedPort,
    },
  };
}

/** Alias → canonical selector → unique workload resolution with typed ambiguity. */
export function resolveEndpointSelection(
  record: StackRecord,
  input: string,
): ResolvedEndpointSelection {
  const exactAlias = record.endpoints.find((endpoint) => endpoint.name === input || endpoint.alias === input);
  if (exactAlias !== undefined) {
    const workload = exactAlias.workload ?? exactAlias.name;
    const binding = exactAlias.binding ?? "main/tcp";
    return { endpoint: exactAlias, workload, binding };
  }

  const selector = input.match(/^([^:]+):((?:main|[1-9][0-9]{0,4})\/(?:tcp|udp))$/);
  if (selector !== null) {
    const resolved = fromBinding(record, selector[1]!, selector[2]!);
    if (resolved !== null) return resolved;
  }

  const service = record.services.find((candidate) => candidate.name === input);
  if (service !== undefined) {
    const bindings = service.bindings ?? (service.publishedPort === undefined ? [] : [{
      id: `${service.name}:main/tcp`,
      target: "main",
      protocol: "tcp" as const,
      publishedPort: service.publishedPort,
    }]);
    if (bindings.length !== 1) {
      throw new HestiaError(
        "service-port-ambiguous",
        `workload ${input} has ${bindings.length} bindings; select ${input}:<target>/<protocol> or an endpoint alias`,
        { selectors: bindings.map((binding) => `${input}:${binding.target}/${binding.protocol}`) },
      );
    }
    const bindingSelector = `${bindings[0]!.target}/${bindings[0]!.protocol}`;
    const resolved = fromBinding(record, input, bindingSelector);
    if (resolved !== null) return resolved;
  }

  throw new HestiaError("service-not-found", `endpoint or workload ${JSON.stringify(input)} was not found`);
}
