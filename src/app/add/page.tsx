import type { Metadata } from "next";
import { AddPhotoFlow } from "./add-photo-flow";

export const metadata: Metadata = { title: "Add an item" };

export default function AddPage() {
  return <AddPhotoFlow />;
}
