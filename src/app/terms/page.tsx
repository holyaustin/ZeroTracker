import LegalPage from "@/components/LegalPage";
export const metadata = { title: "Terms of Service — ZeroTracker" };

export default function Terms() {
  return (
    <LegalPage title="Terms of Service" updated="[date]">
      <p>These terms govern use of ZeroTracker by fleet companies (&ldquo;you&rdquo;). By registering you accept them.</p>
      <h2>Your account</h2>
      <p>You must give accurate company details, including your CAC / BN registration number. We may approve, reject or suspend an account after review. You are responsible for keeping your access key secret and for activity under your account.</p>
      <h2>Lawful, transparent tracking</h2>
      <ul>
        <li>Only track drivers and vehicles you are entitled to track, and tell each driver what is collected and why (our consent screen helps, but does not replace your own duty).</li>
        <li>Do not use ZeroTracker to track anyone covertly or without a lawful basis.</li>
        <li>You are the data controller for your drivers&apos; data and must comply with applicable data-protection law.</li>
      </ul>
      <h2>Acceptable use</h2>
      <p>No unlawful use, no attempts to access other companies&apos; data, no probing or disrupting the service, and no sharing of driver links publicly.</p>
      <h2>Service levels and limits</h2>
      <p>Tracking runs in the driver&apos;s browser. Phones and browsers may pause GPS when the screen is locked or the app is in the background, and coverage depends on mobile networks, so positions can be delayed or missing. ZeroTracker is provided &ldquo;as is&rdquo;, is not a safety or emergency system, and must not be relied on for life-critical decisions.</p>
      <h2>Fees</h2>
      <p>[pricing and billing terms]</p>
      <h2>Suspension and ending</h2>
      <p>We may suspend or end accounts that break these terms. You may stop using the service at any time. When an account ends, its data is deleted on the schedule in the Privacy Notice.</p>
      <h2>Liability and governing law</h2>
      <p>[limitation of liability] · [governing law and courts, e.g. Federal Republic of Nigeria]</p>
      <h2>Contact</h2>
      <p>[legal contact email]</p>
    </LegalPage>
  );
}
