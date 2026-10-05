import { createFileRoute } from "@tanstack/react-router";
import App from "@/jokerz/App";

export const Route = createFileRoute("/")({ component: Home });

function Home() {
  return (
    <div className="min-h-screen bg-[#050505]">
      <App />
    </div>
  );
}
