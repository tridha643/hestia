interface Env {
  MARKER?: string;
}

export default {
  fetch(_req: Request, env: Env): Response {
    return Response.json({ from: "worker-b", marker: env.MARKER ?? "none" });
  },
};
