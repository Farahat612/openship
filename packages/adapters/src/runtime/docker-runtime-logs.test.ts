import { PassThrough } from "node:stream";
import { once } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { DockerRuntime } from "./docker";

async function runtimeWith(stream: PassThrough): Promise<DockerRuntime> {
  const runtime = await DockerRuntime.create({
    dockerSocketPath: "/tmp/openship-runtime-logs-test.sock",
  });
  (runtime as unknown as { _docker: unknown })._docker = {
    getContainer: () => ({ logs: vi.fn(async () => stream) }),
  };
  return runtime;
}

describe("DockerRuntime.streamRuntimeLogs", () => {
  it("reports a natural stream end once", async () => {
    const stream = new PassThrough();
    const onEnd = vi.fn();
    await (await runtimeWith(stream)).streamRuntimeLogs("container-1", vi.fn(), { onEnd });

    const ended = once(stream, "end");
    stream.end();
    await ended;
    stream.emit("close");

    expect(onEnd).toHaveBeenCalledTimes(1);
    expect(onEnd).toHaveBeenCalledWith(undefined);
  });

  it("does not report an explicit cleanup as a natural end", async () => {
    const stream = new PassThrough();
    const onEnd = vi.fn();
    const cleanup = await (await runtimeWith(stream)).streamRuntimeLogs(
      "container-1",
      vi.fn(),
      { onEnd },
    );

    cleanup();
    stream.emit("end");
    stream.emit("close");

    expect(onEnd).not.toHaveBeenCalled();
  });

  it("preserves a source error when the stream terminates", async () => {
    const stream = new PassThrough();
    const onEnd = vi.fn();
    await (await runtimeWith(stream)).streamRuntimeLogs("container-1", vi.fn(), { onEnd });

    stream.emit("error", new Error("socket closed"));
    stream.emit("close");

    expect(onEnd).toHaveBeenCalledTimes(1);
    expect(onEnd).toHaveBeenCalledWith(expect.objectContaining({ message: "socket closed" }));
  });
});

/** One Docker multiplexed frame: `[streamType, 0, 0, 0, uint32be size]` + payload. */
function frame(text: string, streamType = 1): Buffer {
  const payload = Buffer.from(text, "utf-8");
  const header = Buffer.alloc(8);
  header[0] = streamType;
  header.writeUInt32BE(payload.length, 4);
  return Buffer.concat([header, payload]);
}

async function messagesFrom(chunks: Buffer[]): Promise<string[]> {
  const stream = new PassThrough();
  const onLog = vi.fn();
  await (await runtimeWith(stream)).streamRuntimeLogs("container-1", onLog);
  const ended = once(stream, "end");
  for (const chunk of chunks) stream.write(chunk);
  stream.end();
  stream.resume();
  await ended;
  return onLog.mock.calls.map(([entry]) => `${entry.timestamp} ${entry.message}`);
}

describe("DockerRuntime.streamRuntimeLogs frame parsing", () => {
  const first = "2026-10-25T10:00:00.000000000Z GET / 200\n";
  const second = "2026-10-25T10:00:01.000000000Z worker started\n";
  const lines = [
    "2026-10-25T10:00:00.000000000Z GET / 200",
    "2026-10-25T10:00:01.000000000Z worker started",
  ];

  it("strips every frame header when several frames share one chunk", async () => {
    await expect(messagesFrom([Buffer.concat([frame(first), frame(second, 2)])])).resolves.toEqual(
      lines,
    );
  });

  it("reassembles frames whose header or payload straddles chunks", async () => {
    const bytes = Buffer.concat([frame(first), frame(second, 2)]);
    const cuts = [3, 20, bytes.length - 50, bytes.length - 5];
    const chunks = [0, ...cuts].map((start, i) => bytes.subarray(start, cuts[i] ?? bytes.length));
    await expect(messagesFrom(chunks)).resolves.toEqual(lines);
  });

  it("keeps a multi-byte character that is split across chunks", async () => {
    const bytes = frame("2026-10-25T10:00:00.000000000Z café ✓\n");
    const cut = bytes.indexOf(Buffer.from("✓")) + 1;
    await expect(messagesFrom([bytes.subarray(0, cut), bytes.subarray(cut)])).resolves.toEqual([
      "2026-10-25T10:00:00.000000000Z café ✓",
    ]);
  });

  it("passes TTY output, which has no frame headers, through unchanged", async () => {
    await expect(messagesFrom([Buffer.from(first + second)])).resolves.toEqual(lines);
  });
});
