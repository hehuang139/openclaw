import { createEffect } from "@solidjs/signals";

/** Snapshot the initial native value; later owner updates preserve text selection. */
export function liveValue<T extends HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(
  value: () => string,
  onValueChange?: (field: T) => void,
) {
  let field: T | undefined;
  createEffect(value, (next) => {
    if (field && field.value !== next) {
      field.value = next;
      onValueChange?.(field);
    }
  });
  return (element: T) => {
    field = element;
    const next = value();
    if (element.value !== next) {
      element.value = next;
      onValueChange?.(element);
    }
  };
}
