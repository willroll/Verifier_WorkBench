// Text whose `backticked` spans are code, as the checker's and the model's
// messages write them. An unmatched backtick leaves the text as it is.
export function Ticked({ text }: { text: string }) {
  const parts = text.split('`');
  if (parts.length % 2 === 0) return <>{text}</>;
  return <>{parts.map((p, i) => (i % 2 ? <code key={i}>{p}</code> : p))}</>;
}
