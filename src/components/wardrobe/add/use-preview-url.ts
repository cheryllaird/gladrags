"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * A blob: URL for previewing the photo being processed. Setting a new file
 * (or null) revokes the previous URL, and so does unmounting.
 */
export function usePreviewUrl(): [string | null, (file: Blob | null) => void] {
  const [url, setUrl] = useState<string | null>(null);
  const current = useRef<string | null>(null);

  const set = useCallback((file: Blob | null) => {
    if (current.current) URL.revokeObjectURL(current.current);
    current.current = file ? URL.createObjectURL(file) : null;
    setUrl(current.current);
  }, []);

  useEffect(
    () => () => {
      if (current.current) URL.revokeObjectURL(current.current);
    },
    [],
  );

  return [url, set];
}
