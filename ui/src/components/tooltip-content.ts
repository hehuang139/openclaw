export function normalizeTooltipText(text: string) {
  return text.replace(/\s+/g, " ").trim();
}

export function isTooltipTriggerElement(element: unknown): element is HTMLElement | SVGElement {
  return (
    typeof element === "object" &&
    element !== null &&
    "namespaceURI" in element &&
    (element.namespaceURI === "http://www.w3.org/1999/xhtml" ||
      element.namespaceURI === "http://www.w3.org/2000/svg")
  );
}

function isElementNode(node: Node): node is Element {
  return node.nodeType === Node.ELEMENT_NODE;
}

function collectTooltipText(
  element: Element,
  checkOpacity: boolean,
  overflow?: Element[],
  root = true,
  suppressed = false,
): string {
  if (root || isTooltipTriggerElement(element)) {
    overflow?.push(element);
  }
  const style = suppressed
    ? undefined
    : element.ownerDocument.defaultView?.getComputedStyle(element);
  const isSuppressed =
    suppressed ||
    element.hasAttribute("hidden") ||
    (!checkOpacity && element.getAttribute("aria-hidden") === "true") ||
    (checkOpacity && !root && style?.opacity === "0") ||
    style?.display === "none" ||
    style?.contentVisibility === "hidden";
  if (isSuppressed && !overflow) {
    return "";
  }
  // Opacity counts only below the trigger. A fading trigger or ancestor (a menu
  // entering) hides the text and the trigger together, so the hint still repeats it.
  const rendersOwnText =
    !isSuppressed &&
    style?.visibility !== "hidden" &&
    style?.visibility !== "collapse" &&
    (style?.display === "contents" ||
      typeof element.checkVisibility !== "function" ||
      element.checkVisibility({ checkVisibilityCSS: true }));
  return [...element.childNodes]
    .map((node) => {
      if (isElementNode(node)) {
        // Text-suppressed descendants can still carry explicit or measured overflow.
        return collectTooltipText(node, checkOpacity, overflow, false, isSuppressed);
      }
      return node.nodeType === Node.TEXT_NODE && rendersOwnText ? (node.textContent ?? "") : "";
    })
    .join(" ");
}

export function collectTooltipNameText(element: Element): string {
  // Transparent entry animations do not hide text from accessibility APIs.
  // Replacing that name with a title would persist after the animation ends.
  return collectTooltipText(element, false);
}

function hasTooltipOverflow(element: Element) {
  return (
    element.matches("[data-tooltip-overflow]") ||
    element.scrollWidth > element.clientWidth ||
    element.scrollHeight > element.clientHeight
  );
}

export function isTooltipTextRedundant(content: string, trigger: Element) {
  const tooltipText = normalizeTooltipText(content);
  const overflow: Element[] = [];
  const triggerText = normalizeTooltipText(collectTooltipText(trigger, true, overflow));
  if (!tooltipText || !triggerText.includes(tooltipText)) {
    return false;
  }
  return !overflow.some(hasTooltipOverflow);
}
