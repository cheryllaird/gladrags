import { redirect } from "next/navigation";

// The wardrobe is the home screen (it's also where sign-in lands by default).
export default function HomePage() {
  redirect("/wardrobe");
}
