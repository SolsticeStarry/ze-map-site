import { DOC_COLOR_TOKENS, DOC_FONT_SIZE_MIN, DOC_FONT_SIZE_MAX, validateDoc } from './page-schema.mjs';

const escape = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const inline = (node, images) => {
  if (!node) return '';
  if (node.type === 'text') {
    let value = escape(node.text);
    for (const mark of node.marks ?? []) {
      if (mark.type === 'bold') value = `<strong>${value}</strong>`;
      else if (mark.type === 'italic') value = `<em>${value}</em>`;
      else if (mark.type === 'underline') value = `<u>${value}</u>`;
      else if (mark.type === 'strike') value = `<s>${value}</s>`;
      else if (mark.type === 'link' && /^https:\/\//.test(mark.attrs?.href ?? '')) value = `<a href="${escape(mark.attrs.href)}" rel="nofollow noopener">${value}</a>`;
      else if (mark.type === 'textStyle') {
        const attrs = mark.attrs ?? {};
        if (DOC_COLOR_TOKENS.includes(attrs.color)) value = `<span class="doc-color-${escape(attrs.color)}">${value}</span>`;
        if (Number.isInteger(attrs.fontSize) && attrs.fontSize >= DOC_FONT_SIZE_MIN && attrs.fontSize <= DOC_FONT_SIZE_MAX) value = `<span class="doc-size-${attrs.fontSize}">${value}</span>`;
      }
    }
    return value;
  }
  if (node.type === 'hardBreak') return '<br />';
  if (node.type === 'figure') {
    const image = images[(Number(node.attrs?.n) || 0) - 1];
    return image ? `<figure class="doc-figure doc-figure-${node.attrs?.side === 'right' ? 'right' : 'left'}"><img src="${escape(image.localSrc ?? image.src)}" alt="${escape(image.caption ?? '')}" /></figure>` : '';
  }
  return children(node, images);
};

function children(node, images) {
  return (node.content ?? []).map((child) => inline(child, images)).join('');
}

export function docToHtml(doc, images = []) {
  if (!doc || validateDoc(doc).length) return '';
  const render = (node) => {
    const body = children(node, images);
    if (node.type === 'paragraph') return `<p class="doc-align-${node.attrs?.textAlign ?? 'left'}">${body}</p>`;
    if (node.type === 'heading') return `<h${node.attrs.level}>${body}</h${node.attrs.level}>`;
    if (node.type === 'blockquote') return `<blockquote>${body}</blockquote>`;
    if (node.type === 'codeBlock') return `<pre><code>${escape((node.content ?? []).map((item) => item.text ?? '').join(''))}</code></pre>`;
    if (node.type === 'figure') return inline(node, images);
    if (node.type === 'horizontalRule') return '<hr />';
    if (node.type === 'bulletList') return `<ul>${(node.content ?? []).map(render).join('')}</ul>`;
    if (node.type === 'orderedList') return `<ol>${(node.content ?? []).map(render).join('')}</ol>`;
    if (node.type === 'listItem') return `<li>${(node.content ?? []).map(render).join('')}</li>`;
    if (node.type === 'blockquote') return `<blockquote>${body}</blockquote>`;
    return body;
  };
  return (doc.content ?? []).map(render).join('');
}

export function textToDoc(text) {
  return {
    type: 'doc',
    content: String(text ?? '').split(/\n\s*\n/).filter(Boolean).map((paragraph) => {
      const content = [];
      paragraph.split('\n').forEach((line, index) => {
        if (index) content.push({ type: 'hardBreak' });
        if (line) content.push({ type: 'text', text: line });
      });
      return { type: 'paragraph', content };
    }),
  };
}
