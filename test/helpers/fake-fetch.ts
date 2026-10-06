export type RecordedCall = { url: string; headers: Record<string, string> };
export type Responder = (url: string) => Response | Promise<Response>;

/** Queue-based fetch double. Each call consumes the next responder; the last one repeats. */
export function fakeFetch(responders: Responder[]) {
  const calls: RecordedCall[] = [];
  let index = 0;
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    calls.push({ url, headers: Object.fromEntries(new Headers(init?.headers).entries()) });
    const responder = responders[Math.min(index, responders.length - 1)];
    index += 1;
    if (!responder) {
      throw new Error(`fakeFetch: no responder for ${url}`);
    }
    return responder(url);
  }) as typeof fetch;
  return { impl, calls };
}

export function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}
