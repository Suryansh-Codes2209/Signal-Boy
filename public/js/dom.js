/** Tiny DOM helpers, so views can be written as expressions instead of markup strings. */

export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);

  for (const [key, value] of Object.entries(attrs)) {
    if (value == null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (key === 'dataset') {
      Object.assign(node.dataset, value);
    } else {
      node.setAttribute(key, value === true ? '' : String(value));
    }
  }

  for (const child of children.flat()) {
    if (child == null || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

export function clear(node) {
  node.replaceChildren();
  return node;
}

export function $(selector, scope = document) {
  return scope.querySelector(selector);
}

/**
 * A labelled readout. `caveat` explains an unavailable value -- the UI always
 * says why a number is missing rather than printing a blank.
 */
export function stat(label, value, { unit, caveat } = {}) {
  const missing = value == null || value === '';
  return el(
    'div',
    { class: 'stat', dataset: { muted: String(missing) }, title: caveat ?? '' },
    el('dt', { text: label }),
    el(
      'dd',
      {},
      missing ? 'N/A' : String(value),
      !missing && unit ? el('span', { class: 'unit', text: ` ${unit}` }) : null,
    ),
  );
}
