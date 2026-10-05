"use client";
import { useEffect, useState } from "react";

// Keep separators visible while typing, while supplying parsed values to the form.
export function ListInput({
  value,
  onChange,
  placeholder,
  multiline = false,
}: {
  value: string[];
  onChange: (value: string[]) => void;
  placeholder?: string;
  multiline?: boolean;
}) {
  const [draft, setDraft] = useState(value.join(multiline ? "\n" : ", "));
  const [focused, setFocused] = useState(false);
  const joined = value.join(multiline ? "\n" : ", ");
  useEffect(() => {
    if (!focused) setDraft(joined);
  }, [joined, focused]);
  const props = {
    value: draft,
    placeholder,
    onFocus: () => setFocused(true),
    onBlur: () => setFocused(false),
    onChange: (
      e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>,
    ) => {
      setDraft(e.target.value);
      onChange(
        e.target.value
          .split(/[,，\n]/)
          .map((s) => s.trim().replace(/^@/, "").toLowerCase())
          .filter(Boolean),
      );
    },
  };
  return multiline ? <textarea rows={2} {...props} /> : <input {...props} />;
}
