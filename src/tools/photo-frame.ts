import { env } from "cloudflare:workers";
import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-durable";
import { localParts } from "../time";

/** The RPC methods of `FrameControl` in the `frame-dashboard` Worker (polo871209/photo-frame, worker/control.ts). */
interface FrameControl extends Rpc.DurableObjectBranded {
  status(): Promise<FrameStatus>;
  command(command: {
    type: "set";
    settings: { screenOn: boolean };
  }): Promise<FrameStatus>;
}

type FrameStatus = {
  settings: {
    screenOn: boolean;
    night: boolean;
    nightStart: string;
    nightEnd: string;
  };
  frames: number;
};

const text = (value: string) => [{ type: "text" as const, text: value }];

const minutesOf = (clockTime: string) => {
  const [hour, minute] = clockTime.split(":").map(Number);
  return hour! * 60 + minute!;
};

function inNightWindow({
  night,
  nightStart,
  nightEnd,
}: FrameStatus["settings"]) {
  if (!night) return false;
  const { hour, minute } = localParts(Date.now(), env.OWNER_TIMEZONE);
  const now = hour * 60 + minute;
  const from = minutesOf(nightStart);
  const to = minutesOf(nightEnd);
  return from <= to ? from <= now && now < to : now >= from || now < to;
}

function describe({ settings, frames }: FrameStatus) {
  const online = frames > 0 ? "online" : "offline";
  const screen = settings.screenOn ? "on" : "off";
  const night = inNightWindow(settings)
    ? ` The night window (${settings.nightStart} to ${settings.nightEnd}) keeps the screen dark until someone taps it.`
    : "";
  return `The frame is ${online}. The screen setting is ${screen}.${night}`;
}

export const photoFrameTool = defineTool({
  name: "photo_frame",
  deferred: true,
  description:
    "Turn the owner's wall photo frame screen on or off, or check whether it is on and online. Use it when the owner asks to open, close, wake, or sleep the frame. On failure it returns an error code and whether the frame is online.",
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
    if (action === "status") {
      return { output: text(describe(await frame.status())) };
    }
    const screenOn = action === "on";
    const status = await frame.command({ type: "set", settings: { screenOn } });
    const error =
      status.settings.screenOn !== screenOn
        ? "SETTING_NOT_SAVED"
        : status.frames === 0
          ? "FRAME_OFFLINE"
          : screenOn && inNightWindow(status.settings)
            ? "NIGHT_WINDOW"
            : undefined;
    return error
      ? { output: text(`Error ${error}. ${describe(status)}`), isError: true }
      : { output: text(describe(status)) };
  },
});
