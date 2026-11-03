import Logo from "./Logo";

export default function AuthCard({ title, subtitle, children, footer }: {
  title: string; subtitle: string; children: React.ReactNode; footer?: React.ReactNode;
}) {
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-md flex-col justify-center px-5 py-12">
      <div className="mb-8 flex justify-center"><Logo /></div>
      <div className="rounded-2xl border border-white/10 bg-slate-900/60 p-7 shadow-2xl shadow-black/40 backdrop-blur-xl">
        <h1 className="text-xl font-semibold tracking-tight text-white">{title}</h1>
        <p className="mt-1.5 text-sm leading-relaxed text-slate-400">{subtitle}</p>
        <div className="mt-6">{children}</div>
      </div>
      {footer && <div className="mt-6 text-center text-sm text-slate-400">{footer}</div>}
    </main>
  );
}
