/**
 * A form control's name as the required-field helpers read it: the text of its `<label for>`,
 * else of the label wrapping it without the controls inside, else of its `aria-labelledby`
 * elements, else its `aria-label`, with spacing and zero-width spaces folded. Self-contained: page
 * code pastes it from its own source.
 */
export const fieldName = (element: Element): string => {
  const words = (text: string | null | undefined) => String(text ?? "").replace(/[\s​]+/g, " ").trim();
  // A wrapping label holds the control itself, whose value or options are not its name.
  const labelText = (label: Element) => {
    const copy = label.cloneNode(true) as Element;
    copy.querySelectorAll("input, select, textarea, [role=listbox], [role=combobox], [role=option]").forEach((inner) => inner.remove());
    return words(copy.textContent);
  };
  const labels = Array.from((element as HTMLInputElement).labels ?? []);
  const byFor = labels.find((label) => !label.contains(element));
  if (byFor) return labelText(byFor);
  const wrapping = element.closest("label");
  if (wrapping) return labelText(wrapping);
  const ids = (element.getAttribute("aria-labelledby") ?? "").split(/\s+/).filter(Boolean);
  const named = ids.map((id) => element.ownerDocument.getElementById(id)).filter((node) => node !== null);
  if (named.length > 0) return words(named.map((node) => node.textContent).join(" "));
  return words(element.getAttribute("aria-label"));
};
