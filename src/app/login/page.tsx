import Link from "next/link";
import AuthCard from "@/components/AuthCard";
import AuthForm from "@/components/AuthForm";

export default function Login() {
  return (
    <AuthCard title="Manager sign in" subtitle="Use the email you registered with and the access key we emailed you."
      footer={<><Link href="/forgot" className="font-medium text-emerald-400 hover:text-emerald-300">Forgot your access key?</Link><span className="mx-2 text-slate-600">·</span><Link href="/register" className="font-medium text-emerald-400 hover:text-emerald-300">Create an account</Link></>}>
      <AuthForm endpoint="/api/auth/login" redirect="/dashboard" submit="Sign in" fields={[
        { name: "email", label: "Work email", type: "email", placeholder: "you@company.com", autoComplete: "email" },
        { name: "accessKey", label: "Access key", type: "password", placeholder: "ZT-••••••••", autoComplete: "current-password" },
      ]} />
    </AuthCard>
  );
}
