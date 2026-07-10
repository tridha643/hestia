interface Env {
  B: { fetch(input: string | Request): Promise<Response> };
}

export default {
  async fetch(_req: Request, env: Env): Promise<Response> {
    const res = await env.B.fetch("http://b/");
    const body = (await res.json()) as { marker: string };
    return Response.json({ from: "worker-a", viaBinding: body.marker });
  },
};
