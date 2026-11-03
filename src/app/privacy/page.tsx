import LegalPage from "@/components/LegalPage";
export const metadata = { title: "Privacy Notice — ZeroTracker" };

export default function Privacy() {
  return (
    <LegalPage title="Privacy Notice" updated="[date]">
      <p>ZeroTracker lets a fleet company see where its vehicles are by using the driver&apos;s phone browser. This notice explains what is collected, why, and your rights. It is written with the Nigeria Data Protection Act (NDPA) / NDPR and similar laws such as the GDPR in mind.</p>
      <h2>Who is responsible</h2>
      <p>The <strong>fleet company</strong> that gave you a tracking link decides why and how your location is used (the data controller). ZeroTracker, operated by <strong>[company name, address, contact email]</strong>, processes the data on its behalf.</p>
      <h2>What we collect, and only while a trip is ON</h2>
      <ul>
        <li><strong>Location:</strong> latitude, longitude, GPS accuracy, heading and speed.</li>
        <li><strong>Motion:</strong> a combined acceleration reading, used only to detect severe impacts and potholes.</li>
        <li><strong>Phone status:</strong> battery level and charging state, and whether the app is in the foreground or background.</li>
        <li><strong>Technical data:</strong> timestamps, and the vehicle your link is assigned to. We do not ask for your name, and drivers have no account.</li>
      </ul>
      <p>Nothing is collected before you agree and tap Start, or after you tap End trip. A visible &ldquo;Location sharing is ON&rdquo; indicator is shown while sharing.</p>
      <h2>Why</h2>
      <p>To show your fleet manager the vehicle&apos;s position and route, to alert them to impacts and low battery, and to keep a log of incidents. We do not sell the data or use it for advertising.</p>
      <h2>Who can see it</h2>
      <p>Only the fleet company that owns the link, and ZeroTracker staff when needed to run or secure the service. Each company can see only its own vehicles.</p>
      <h2>How long we keep it</h2>
      <p>Location history is deleted after <strong>30 days</strong> and the incident log after <strong>90 days</strong>, automatically.</p>
      <h2>Your rights</h2>
      <p>You can stop sharing at any time by ending the trip or closing the page, and ask your fleet company (or us) to access, correct or delete your data, and to object to processing. You may also complain to the Nigeria Data Protection Commission or your local regulator.</p>
      <h2>Security</h2>
      <p>Data is sent over HTTPS, access links are stored only as hashes, and every account is isolated from every other. No system is perfectly secure, and we will notify affected parties of a breach as the law requires.</p>
      <h2>Contact</h2>
      <p>[privacy contact email]</p>
    </LegalPage>
  );
}
