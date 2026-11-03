import AuthCard from "@/components/AuthCard";
import AuthForm from "@/components/AuthForm";

export const metadata = { title: "Owner Central Command — ZeroTracker", robots: { index: false } };

export default function OwnerLogin() {
  return (
    <AuthCard title="Owner Central Command" subtitle="Restricted to ZeroTracker platform owners.">
      <AuthForm endpoint="/api/owner/login" redirect="/owner" submit="Enter command center" fields={[
        { name: "email", label: "Owner email", type: "email", autoComplete: "username" },
        { name: "password", label: "Password", type: "password", autoComplete: "current-password" },
      ]} />
    </AuthCard>
  );
}
