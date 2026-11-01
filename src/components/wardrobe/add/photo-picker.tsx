"use client";

import { CameraIcon, ImageIcon } from "lucide-react";
import { useId, useRef } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * "Take a photo" (opens the camera) and "Choose from library" buttons, each
 * backed by its own file input. Accepts any image the phone offers; the
 * add flow re-encodes it as JPEG before upload, which also handles HEIC.
 *
 * With `onFiles`, the library lets the user pick several photos at once
 * and hands them all over (in the order chosen); the camera still takes
 * one at a time and goes to `onFile`.
 */
export function PhotoPicker({
  onFile,
  onFiles,
  disabled,
  cameraLabel = "Take a photo",
  libraryLabel = "Choose from library",
  libraryFirst = false,
  className,
}: {
  onFile: (file: File) => void;
  /** Several photos picked from the library at once (two or more). One goes to onFile. */
  onFiles?: (files: File[]) => void;
  disabled?: boolean;
  cameraLabel?: string;
  libraryLabel?: string;
  /** Put the library button first and primary (e.g. for screenshots). */
  libraryFirst?: boolean;
  className?: string;
}) {
  const cameraRef = useRef<HTMLInputElement>(null);
  const libraryRef = useRef<HTMLInputElement>(null);
  const id = useId();

  function handleChange(event: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? []);
    // Reset so choosing the same file again still fires a change.
    event.target.value = "";
    if (files.length > 1 && onFiles) onFiles(files);
    else if (files[0]) onFile(files[0]);
  }

  const camera = (
    <Button
      key="camera"
      type="button"
      size="lg"
      variant={libraryFirst ? "outline" : "default"}
      disabled={disabled}
      onClick={() => cameraRef.current?.click()}
    >
      <CameraIcon aria-hidden="true" />
      {cameraLabel}
    </Button>
  );
  const library = (
    <Button
      key="library"
      type="button"
      size="lg"
      variant={libraryFirst ? "default" : "outline"}
      disabled={disabled}
      onClick={() => libraryRef.current?.click()}
    >
      <ImageIcon aria-hidden="true" />
      {libraryLabel}
    </Button>
  );

  return (
    <div className={cn("grid gap-2", className)}>
      {libraryFirst ? [library, camera] : [camera, library]}
      <input
        ref={cameraRef}
        id={`${id}-camera`}
        type="file"
        accept="image/*"
        capture="environment"
        className="sr-only"
        tabIndex={-1}
        aria-hidden="true"
        data-testid="photo-camera-input"
        onChange={handleChange}
      />
      <input
        ref={libraryRef}
        id={`${id}-library`}
        type="file"
        accept="image/*"
        multiple={onFiles !== undefined}
        className="sr-only"
        tabIndex={-1}
        aria-hidden="true"
        data-testid="photo-library-input"
        onChange={handleChange}
      />
    </div>
  );
}
