import Nav from "./components/Nav";
import Hero from "./components/Hero";
import Problem from "./components/Problem";
import HowItWorks from "./components/HowItWorks";
import Architecture from "./components/Architecture";
import PrivacyDemo from "./components/PrivacyDemo";
import Pinocchio from "./components/Pinocchio";
import Personas from "./components/Personas";
import TechStack from "./components/TechStack";
import Security from "./components/Security";
import FAQ from "./components/FAQ";
import CTA from "./components/CTA";
import Footer from "./components/Footer";

export default function Page() {
  return (
    <>
      <Nav />
      <main className="flex-1">
        <Hero />
        <Problem />
        <HowItWorks />
        <Architecture />
        <PrivacyDemo />
        <Pinocchio />
        <Personas />
        <TechStack />
        <Security />
        <FAQ />
        <CTA />
      </main>
      <Footer />
    </>
  );
}
