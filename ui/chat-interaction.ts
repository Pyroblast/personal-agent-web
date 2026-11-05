export function sendsMessage(e: {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  isComposing: boolean;
  keyCode?: number;
  repeat?: boolean;
}) {
  return (
    e.key === "Enter" &&
    (e.metaKey || e.ctrlKey) &&
    !e.shiftKey &&
    !e.altKey &&
    !e.isComposing &&
    e.keyCode !== 229 &&
    !e.repeat
  );
}
export function dayKey(time: number) {
  return new Date(time).toLocaleDateString("sv-SE", {
    timeZone: "Asia/Shanghai",
  });
}
export function dateLabel(time: number) {
  const today = dayKey(Date.now());
  const day = dayKey(time);
  if (day === today) return "今天";
  if (day === dayKey(Date.now() - 86400000)) return "昨天";
  return new Date(time).toLocaleDateString("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}
