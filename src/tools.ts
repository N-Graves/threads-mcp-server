import { z } from "zod";
import { HttpClient, ToolError, boundedText, httpUrl, pageSize, type ToolDefinition } from "@nasdigitaluk/mcp-server-core";

/**
 * Publishing on Threads is two calls, not one: create a container, then
 * publish it. Meta's own guidance is to wait in between so the container
 * finishes processing server-side — an image container needs longer, because
 * Meta has to fetch and process the image from a URL you give it.
 *
 * The server this replaces waited a flat 30 seconds for text and 45 for an
 * image, blocking the whole tool call whether or not the container was ready.
 * That is both slower than it needs to be in the common case and, on a slow
 * image fetch, still not long enough.
 *
 * So this polls the container's own status instead, and falls back to waiting
 * out the remaining time if Threads does not return a `status` field — the
 * field is not guaranteed on every container type, and a fallback that
 * degrades to the old behaviour is better than one that publishes early.
 */
async function waitForContainer(
  http: HttpClient,
  containerId: string,
  budgetMs: number,
  sleep: (ms: number) => Promise<void>,
): Promise<void> {
  const STEP_MS = 3000;
  const deadline = Date.now() + budgetMs;
  // Bounded by attempts as well as by the clock. Time alone is not enough: if
  // the status endpoint answers in a few milliseconds the loop becomes a tight
  // request storm against Meta for the whole budget, which is a good way to be
  // rate-limited for asking politely.
  let attemptsLeft = Math.max(1, Math.ceil(budgetMs / STEP_MS));
  let statusSeen = false;

  while (Date.now() < deadline && attemptsLeft-- > 0) {
    await sleep(Math.min(STEP_MS, Math.max(0, deadline - Date.now())));
    const res = (await http.get(`/${encodeURIComponent(containerId)}`, {
      fields: "status,error_message",
    })) as { status?: string; error_message?: string };

    if (typeof res.status !== "string") continue;
    statusSeen = true;

    if (res.status === "FINISHED") return;
    if (res.status === "ERROR" || res.status === "EXPIRED") {
      throw new ToolError(
        `Threads could not process the container (${res.status})` +
          (res.error_message ? `: ${res.error_message}` : "") +
          ". Nothing was published.",
      );
    }
  }

  if (statusSeen) {
    throw new ToolError(
      "The Threads container was still processing when the wait budget ran out. " +
        "Nothing was published. This usually means the image URL is slow to fetch.",
    );
  }
  // No status field ever came back. The time has been spent regardless, which
  // is exactly what the old blind wait did, so publishing now is no worse.
}

export function buildTools(
  http: HttpClient,
  userId?: string,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): ToolDefinition<any>[] {
  const requireUser = (given?: string) => {
    const id = given ?? userId;
    if (!id) {
      throw new ToolError(
        "No Threads user id. Pass user_id, or set THREADS_USER_ID. " +
          "threads_get_profile with user_id='me' will tell you yours.",
      );
    }
    return encodeURIComponent(id);
  };

  return [
    {
      name: "threads_get_profile",
      description:
        "A Threads profile. Pass user_id='me' for the authenticated account, which is also " +
        "how you find your own numeric id.",
      action: "read",
      input: z.object({
        user_id: z.string().optional(),
        fields: z
          .string()
          .optional()
          .describe("Comma-separated. Defaults to id,username,threads_profile_picture_url."),
      }),
      handler: ({ user_id, fields }) =>
        http.get(`/${requireUser(user_id)}`, {
          fields: fields ?? "id,username,threads_profile_picture_url",
        }),
    },

    {
      name: "threads_create_post",
      description:
        "Publish to Threads. This is immediately public and there is no draft state — the " +
        "only undo is threads_delete_post, and everyone who saw it still saw it.\n\n" +
        "An image is fetched by Threads from the URL you give, server-side, so it must be a " +
        "publicly reachable http(s) URL. A local file path cannot work here.",
      action: "write",
      input: z.object({
        text: boundedText(500).describe("Threads caps text posts at 500 characters."),
        image_url: httpUrl
          .optional()
          .describe("Public http(s) URL Threads can fetch. Not a local path."),
        reply_to_id: z.string().optional().describe("Post id to reply to."),
        user_id: z.string().optional(),
        wait_seconds: z
          .number()
          .int()
          .min(5)
          .max(120)
          .optional()
          .describe("How long to let the container process. Default 30, or 60 with an image."),
      }),
      handler: async ({ text, image_url, reply_to_id, user_id, wait_seconds }) => {
        const id = requireUser(user_id);
        const container = (await http.post(`/${id}/threads`, undefined, {
          text,
          media_type: image_url ? "IMAGE" : "TEXT",
          ...(image_url ? { image_url } : {}),
          ...(reply_to_id ? { reply_to_id } : {}),
        })) as { id?: string };

        if (!container.id) {
          throw new ToolError(
            "Threads accepted the request but returned no container id, so there is nothing " +
              "to publish. Nothing was posted.",
          );
        }

        await waitForContainer(
          http,
          container.id,
          (wait_seconds ?? (image_url ? 60 : 30)) * 1000,
          sleep,
        );

        return http.post(`/${id}/threads_publish`, undefined, { creation_id: container.id });
      },
    },

    {
      name: "threads_get_my_posts",
      description:
        "Your recent posts with their permalinks. Worth calling after publishing: it is how " +
        "you confirm what actually went out rather than assuming the two-step container-and- " +
        "publish sequence succeeded.",
      action: "read",
      input: z.object({
        limit: pageSize(100, 10),
        user_id: z.string().optional(),
      }),
      handler: ({ limit, user_id }) =>
        http.get(`/${requireUser(user_id)}/threads`, {
          fields: "id,media_type,text,permalink,timestamp",
          limit,
        }),
    },

    {
      name: "threads_get_post_insights",
      description: "Engagement on one of your posts: views, likes, replies, reposts, quotes.",
      action: "read",
      input: z.object({ post_id: z.string().min(1) }),
      handler: ({ post_id }) =>
        http.get(`/${encodeURIComponent(post_id)}/insights`, {
          metric: "views,likes,replies,reposts,quotes",
        }),
    },

    {
      name: "threads_delete_post",
      description: "Delete one of your own posts. Irreversible.",
      action: "destructive",
      input: z.object({ post_id: z.string().min(1) }),
      handler: ({ post_id }) => http.delete(`/${encodeURIComponent(post_id)}`),
    },

    {
      name: "threads_call",
      description:
        "Call any Threads Graph API endpoint directly, for anything the tools above do not " +
        "cover. Meta publishes no machine-readable spec for Threads, so this server does not " +
        "claim a complete catalogue — this passthrough is how you reach the rest of the API " +
        "without waiting for a tool to be written for it. Paths are relative to " +
        "https://graph.threads.net/v1.0.",
      action: "destructive",
      input: z.object({
        path: z
          .string()
          .min(1)
          .refine((p) => p.startsWith("/"), "Path must start with /")
          .describe("e.g. /me/threads_publishing_limit"),
        method: z.enum(["GET", "POST", "DELETE"]).optional().default("GET"),
        query: z.record(z.union([z.string(), z.number(), z.boolean()])).optional(),
      }),
      handler: ({ path, method, query }) =>
        http.request(path, { method, query: query ?? {} }),
    },
  ];
}
