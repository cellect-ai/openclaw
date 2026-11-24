import type { MatrixClient as MatrixJsClient } from "matrix-js-sdk/lib/matrix.js";
import { ClientEvent } from "matrix-js-sdk/lib/matrix.js";

export type HeadlessMatrixRtcControl = {
  matrixRTC?: { stop: () => void };
  startMatrixRTC?: (...args: unknown[]) => void;
};

export function disableHeadlessMatrixRtc(client: MatrixJsClient): void {
  const rtcControl = client as unknown as HeadlessMatrixRtcControl;
  // matrix-js-sdk starts its RTC membership manager after initial sync even
  // when VoIP is disabled. OpenClaw's Matrix plugin is a headless messaging
  // client; voice uses the gateway Talk relay, so walking RTC state for every
  // joined room only blocks the gateway event loop.
  if (typeof rtcControl.startMatrixRTC === "function") {
    client.off(ClientEvent.Sync, rtcControl.startMatrixRTC);
    // startClient() registers this callback again, so removing the constructor
    // listener alone is not sufficient. Replace the SDK-private callback before
    // startup so the later registration is inert as well.
    rtcControl.startMatrixRTC = () => {};
  }
  rtcControl.matrixRTC?.stop();
}
