import { expect, vi } from "vitest";
import { flush } from "../../test-helpers/solid-settle.ts";

export function editTrigger(input: HTMLTextAreaElement, value: string) {
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

export async function tick(ms = 0) {
  await vi.advanceTimersByTimeAsync(ms);
  flush();
}

export const triggerInput = (page: HTMLElement) => page.querySelector("textarea")!;
export const triggerAlert = (page: HTMLElement) => page.querySelector("[role='alert']");
export const retryTrigger = (page: HTMLElement) =>
  page.querySelector<HTMLButtonElement>("[role='alert'] button")?.click();
export const expectTriggerWrite = (request: unknown, text: string) =>
  expect(request).toHaveBeenLastCalledWith("voicewake.set", { triggers: [text] });
export const expectFocused = (input: HTMLTextAreaElement, value: string) => {
  expect(input.value).toBe(value);
  expect(document.activeElement).toBe(input);
};
