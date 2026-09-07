import { describe, it, expect } from "vitest";
import { HttpClient } from "@nasdigitaluk/mcp-server-core";
import { buildTools } from "../src/tools.js";

/**
 * A client whose responses are chosen by URL rather than by call order.
 *
 * Order-based scripting looked simpler and was wrong: the container poll loop
 * runs as many times as the wait budget allows, so the number of status calls
 * is not something a test should be pinning.
 */
function client(respond: (url: string, method: string) => Response) {
  const calls: { url: string; method: string }[] = [];
  const http = new HttpClient({
    baseUrl: "https://graph.threads.net/v1.0",
    headers: { Authorization: "Bearer fake" },
    fetchImpl: (async (url: string, opts: RequestInit = {}) => {
      const method = opts.method ?? "GET";
      calls.push({ url, method });
      return respond(url, method);
    }) as unknown as typeof fetch,
  });
  return { http, calls };
}

const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

const noSleep = async () => {};
const tool = (http: HttpClient, name: string, userId = "42") =>
  buildTools(http, userId, noSleep).find((t) => t.name === name)!;

describe("credentials", () => {
  it("sends the token in a header, never the query string", async () => {
    // The server this replaces put access_token=... in every URL, which lands
    // the credential in access logs, proxy logs and browser history.
    const { http, calls } = client(() => json({ id: "42" }));
    await tool(http, "threads_get_profile").handler({});
    expect(calls[0]!.url).not.toContain("access_token");
  });
});

describe("publishing", () => {
  it("waits for the container to finish before publishing", async () => {
    let polls = 0;
    const { http, calls } = client((url) => {
      if (url.includes("/threads_publish")) return json({ id: "post-1" });
      if (url.includes("/42/threads")) return json({ id: "container-1" });
      return json({ status: ++polls < 2 ? "IN_PROGRESS" : "FINISHED" });
    });
    const res = await tool(http, "threads_create_post").handler({ text: "hello" });
    expect(res).toEqual({ id: "post-1" });
    // It polled until FINISHED, then published - and published exactly once.
    expect(polls).toBe(2);
    expect(calls.filter((c) => c.url.includes("threads_publish"))).toHaveLength(1);
  });

  it("does not publish a container Threads reports as failed", async () => {
    // Publishing a broken container is how you get a post that is not there,
    // reported as a success.
    const { http, calls } = client((url) =>
      url.includes("/42/threads")
        ? json({ id: "container-1" })
        : json({ status: "ERROR", error_message: "could not fetch image" }),
    );
    await expect(
      tool(http, "threads_create_post").handler({
        text: "hi",
        image_url: "https://example.com/a.png",
      }),
    ).rejects.toThrow(/could not fetch image[\s\S]*Nothing was published/);
    expect(calls.filter((c) => c.url.includes("threads_publish"))).toHaveLength(0);
  });

  it("publishes anyway when Threads never returns a status field", async () => {
    // The field is not guaranteed on every container type. Falling back to the
    // old blind wait is no worse than what it replaces; refusing would make
    // the tool unusable on containers that simply do not report status.
    const { http } = client((url) =>
      url.includes("/threads_publish") ? json({ id: "posted" }) : json({ id: "c" }),
    );
    await expect(
      tool(http, "threads_create_post").handler({ text: "hi", wait_seconds: 5 }),
    ).resolves.toEqual({ id: "posted" });
  });

  it("refuses when no container id comes back, rather than publishing nothing", async () => {
    const { http, calls } = client(() => json({}));
    await expect(tool(http, "threads_create_post").handler({ text: "hi" })).rejects.toThrow(
      /no container id/i,
    );
    expect(calls).toHaveLength(1);
  });

  it("refuses a local file path for the image", async () => {
    // Threads fetches the image server-side, so a path on this machine can
    // never work. Better a validation error than a container that fails 60
    // seconds later.
    const t = tool(client(() => json({})).http, "threads_create_post");
    expect(t.input.safeParse({ text: "hi", image_url: "/home/me/a.png" }).success).toBe(false);
    expect(t.input.safeParse({ text: "hi", image_url: "https://x.test/a.png" }).success).toBe(true);
  });

  it("holds callers to the 500-character limit Threads enforces", () => {
    const t = tool(client(() => json({})).http, "threads_create_post");
    expect(t.input.safeParse({ text: "x".repeat(501) }).success).toBe(false);
  });
});

describe("tools", () => {
  it("classifies posting as a write and deleting as destructive", () => {
    const tools = buildTools(client(() => json({})).http, "42", noSleep);
    expect(tools.find((t) => t.name === "threads_create_post")!.action).toBe("write");
    expect(tools.find((t) => t.name === "threads_delete_post")!.action).toBe("destructive");
    expect(tools.find((t) => t.name === "threads_get_my_posts")!.action).toBe("read");
  });

  it("explains how to find a user id rather than failing bare", () => {
    const { http } = client(() => json({}));
    const noDefault = buildTools(http, undefined, noSleep).find(
      (t) => t.name === "threads_get_my_posts",
    )!;
    expect(() => noDefault.handler({ limit: 10 })).toThrow(/THREADS_USER_ID/);
  });

  it("passes through to any endpoint, because there is no catalogue to be complete against", async () => {
    const { http, calls } = client(() => json({}));
    await tool(http, "threads_call").handler({
      path: "/me/threads_publishing_limit",
      method: "GET",
    });
    expect(calls[0]!.url).toContain("/me/threads_publishing_limit");
  });

  it("refuses a passthrough path that is not a path", () => {
    const t = tool(client(() => json({})).http, "threads_call");
    expect(t.input.safeParse({ path: "https://evil.test/x" }).success).toBe(false);
  });
});
