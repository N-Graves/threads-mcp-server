# threads-mcp-server

A [Model Context Protocol](https://modelcontextprotocol.io) server for the **Meta Threads API**.

MIT licensed.

## Install

```bash
npm install -g @nasdigital/threads-mcp
```

## Configuration

```json
{
  "env": {
    "THREADS_ACCESS_TOKEN": "your-long-lived-token",
    "THREADS_USER_ID": "your-numeric-id"
  }
}
```

`THREADS_USER_ID` is optional — it just defaults the `user_id` argument. `threads_get_profile` with `user_id: "me"` will tell you yours.

**Getting a token:** the Threads app dashboard has a built-in User Token Generator, much simpler than a full OAuth redirect flow. It only works once the Threads account is set to **public** — otherwise it silently produces nothing useful rather than saying why.

## ⚠️ The token goes in a header, not the URL

Meta's own examples put `access_token=...` in the query string, and the server this replaces followed them. That puts the credential in access logs, proxy logs and browser history for every single request.

Here it is an `Authorization: Bearer` header, and there is a test asserting no request URL contains `access_token`.

## Publishing is two calls, and the wait is the interesting part

Threads publishing is: create a container, wait for it to process, then publish it. Meta's guidance is to wait in between — longer for an image, because Meta fetches and processes it from a URL you supply.

The server this replaces waited a **flat 30 seconds for text and 45 for an image**, blocking the whole tool call regardless of whether the container was ready. That is slower than necessary in the common case and, on a slow image fetch, still not long enough.

This one **polls the container's own status** instead, and:

- publishes as soon as it reports `FINISHED`;
- **refuses to publish** a container reporting `ERROR` or `EXPIRED`, passing Meta's own reason through — publishing a broken container is how you get a post that is not there, reported as a success;
- is bounded by **attempts as well as by the clock**, so a fast-responding status endpoint cannot turn the wait into a request storm;
- falls back to waiting out the budget if Threads never returns a `status` field at all. That field is not guaranteed on every container type, and degrading to the old blind wait is better than refusing to publish something that would have been fine.

An image must be a **public http(s) URL** that Threads can fetch server-side. A local file path can never work, so it is rejected at validation rather than sixty seconds later.

## What is NOT covered, and why that is stated rather than hidden

Meta publishes **no machine-readable spec** for the Threads API. Every other server in this family checks its catalogue against the provider's own document and fails the build when the provider adds an endpoint; that is not possible here.

So this server does **not** claim complete coverage. It wraps the operations that are verified working, and ships `threads_call` as a documented passthrough onto the rest of `https://graph.threads.net/v1.0` — replies, conversations, publishing limits, mentions, reposts and anything Meta adds next. That is an honest position rather than a catalogue that quietly goes stale.

## Tools

| Tool | |
|---|---|
| `threads_get_profile` | A profile. `user_id: "me"` finds your own id. |
| `threads_create_post` | Publish. Immediately public, no draft state. |
| `threads_get_my_posts` | Your recent posts with permalinks. |
| `threads_get_post_insights` | Views, likes, replies, reposts, quotes. |
| `threads_delete_post` | Delete your own post. Irreversible. |
| `threads_call` | Anything else on the Graph API. |

Posting is a **write** rather than destructive — it can be deleted — but everyone who saw it still saw it, and the tool description says so. Deleting is destructive. `threads_call` reaches deletes, so it is destructive too.

After publishing, `threads_get_my_posts` is worth calling: it is how you confirm what actually went out, rather than assuming the container-then-publish sequence succeeded.

## Read-only and no-destructive modes

```
MCP_READ_ONLY=1       refuse anything that changes state
MCP_NO_DESTRUCTIVE=1  allow posting, refuse deletes
```

## Testing

```bash
npm test                                             # 11 tests
SMOKE_ENV='{"THREADS_ACCESS_TOKEN":"x"}' npm run smoke   # real MCP over stdio
```

The smoke test runs with no credentials and no private task board reachable, and every assertion is about the server's own behaviour — nothing in it touches Meta or needs an account.

## Built on

[`@nasdigital/mcp-server-core`](https://github.com/N-Graves/mcp-server-core).

## Licence

MIT.
