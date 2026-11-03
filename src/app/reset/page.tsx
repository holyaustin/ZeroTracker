import Link from "next/link";
import AuthCard from "@/components/AuthCard";
import AuthForm from "@/components/AuthForm";

export default async function Reset({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  const { token } = await searchParams;
  return (
    <AuthCard title="Choose a new access key" subtitle="Pick something long and unique. You'll use it with your email to sign in."
      footer={<Link href="/login" className="font-medium text-emerald-400 hover:text-emerald-300">Back to sign in</Link>}>
      {token ? (
        <AuthForm endpoint="/api/auth/reset" hidden={{ token }} submit="Update access key" fields={[
          { name: "newKey", label: "New access key", type: "password", autoComplete: "new-password", hint: "At least 12 characters." },
        ]} />
      ) : (
        <p role="alert" className="rounded-lg border border-rose-400/20 bg-rose-400/10 px-3 py-2 text-sm text-rose-200">
          This reset link is missing its token. Request a new one from the <Link href="/forgot" className="font-medium text-emerald-400 hover:text-emerald-300">forgot key page</Link>.
        </p>
      )}
    </AuthCard>
  );
}
