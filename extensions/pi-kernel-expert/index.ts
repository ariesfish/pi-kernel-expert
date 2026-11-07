/**
 * pi-kernel-expert — pi extension.
 *
 * This file is the composition root. Kernel work runs on pi-goal's
 * frozen-contract loop: this package contributes knowledge, evidence, and the
 * generated scripts that make kernel criteria executable. It deliberately owns
 * no phase machine and no gate of its own.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { registerStatusCommand } from "./tools/status.ts";

export default function kernelExpertExtension(pi: ExtensionAPI): void {
  registerStatusCommand(pi);
}
