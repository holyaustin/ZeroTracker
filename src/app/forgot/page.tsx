import Link from "next/link";
import AuthCard from "@/components/AuthCard";
import AuthForm from "@/components/AuthForm";

export default function Forgot() {
  return (
    <AuthCard title="Reset your access key" subtitle="Enter your email and we'll send a single-use link that expires in 30 minutes."
      footer={<Link href="/login" className="font-medium text-emerald-400 hover:text-emerald-300">Back to sign in</Link>}>
      <AuthForm endpoint="/api/auth/forgot" submit="Send reset link" fields={[
        { name: "email", label: "Work email", type: "email", placeholder: "you@company.com", autoComplete: "email" },
      ]} />
    </AuthCard>
  );
}
