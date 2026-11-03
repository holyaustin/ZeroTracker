import Link from "next/link";
import AuthCard from "@/components/AuthCard";
import AuthForm from "@/components/AuthForm";

export default function Register() {
  return (
    <AuthCard title="Register your company" subtitle="We'll email you a secure access key. There's no password to invent or remember."
      footer={<>By registering you accept our <Link href="/terms" className="underline">Terms</Link> and <Link href="/privacy" className="underline">Privacy Notice</Link>.<br />Already registered? <Link href="/login" className="font-medium text-emerald-400 hover:text-emerald-300">Sign in</Link></>}>
      <AuthForm endpoint="/api/auth/register" submit="Get my access key" fields={[
        { name: "name", label: "Company name", placeholder: "Acme Logistics Ltd", autoComplete: "organization" },
        { name: "email", label: "Work email", type: "email", placeholder: "you@company.com", autoComplete: "email" },
      ]} />
    </AuthCard>
  );
}
