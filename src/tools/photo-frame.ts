import { env } from "cloudflare:workers";
import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-durable";

/** The RPC methods of `FrameControl` in the `frame-dashboard` Worker (polo871209/photo-frame, worker/control.ts). */
interface FrameControl extends Rpc.DurableObjectBranded {
  status(): Promise<FrameStatus>;
  command(command: { type: "screen"; on: boolean }): Promise<FrameStatus>;
}

type FrameStatus = { settings: { screenOn: boolean }; frames: number };

const text = (value: string) => [{ type: "text" as const, text: value }];

function describe({ settings, frames }: FrameStatus) {
  const screen = settings.screenOn ? "on" : "off";
  return frames > 0
    ? `The frame screen is ${screen}.`
    : `The frame screen is set to ${screen}, but the frame is offline. It applies the setting when it reconnects.`;
}

export const photoFrameTool = defineTool({
  name: "photo_frame",
  deferred: true,
  description:
    "Turn the owner's wall photo frame screen on or off, or check whether it is on and online. Use it when the owner asks to open, close, wake, or sleep the frame.",
  parameters: Type.Object({
    action: Type.Union([
      Type.Literal("on"),
      Type.Literal("off"),
      Type.Literal("status"),
    ]),
  }),
  replay: "safe",
  async execute({ action }) {
    const frame = (
      env.FRAME_CONTROL as unknown as DurableObjectNamespace<FrameControl>
    ).getByName("frame");
    const status =
      action === "status"
        ? await frame.status()
        : await frame.command({ type: "screen", on: action === "on" });
    return { output: text(describe(status)) };
  },
});
