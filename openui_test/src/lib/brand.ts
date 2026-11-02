/**
 * Brand editions. One build per brand, picked at build time by
 * NEXT_PUBLIC_BRAND=lake|span. Unset keeps the neutral Queryable Chatbot
 * exactly as it was. Every brand string, logo and link the UI shows comes
 * from this map.
 */
export type BrandId = "lake" | "span";

type Brand = {
  id: BrandId | null;
  name: string;
  productName: string;
  /** Sign-in heading line and auth topbar wordmark, split so the second half can take the accent. */
  wordmark: [string, string];
  tagline: string;
  websiteUrl: string;
  /** Logo for light grounds, and for dark grounds when the brand has an approved reversed file. */
  logo: { light: string; dark: string | null; alt: string; width: number; height: number };
  welcome: string;
  /** Starter questions for the brand's own data; null keeps the neutral demo starters. */
  starters: { displayText: string; prompt: string }[] | null;
  /** Line under the composer. */
  disclaimer: string;
  /** Sign-in showcase: a sample answer. Brand figures are real counts from the brand's own test data. */
  showcase: {
    eyebrow: string;
    question: string;
    title: string;
    unit: string;
    bars: { label: string; value: number }[];
    foot: string;
    source: string;
  };
};

const BRANDS: Record<BrandId | "neutral", Brand> = {
  neutral: {
    id: null,
    name: "Queryable Chatbot",
    productName: "Queryable Chatbot",
    wordmark: ["Queryable", "Chatbot"],
    tagline: "Data intelligence",
    websiteUrl: "",
    logo: { light: "/queryable-logo-light.svg", dark: "/queryable-logo-dark.svg", alt: "", width: 30, height: 30 },
    starters: null,
    disclaimer: "Queryable can make mistakes. Check important figures against the query inspector.",
    welcome: "Ask about companies, customers, orders, products and sales. Every number comes straight from your MongoDB data.",
    showcase: {
      eyebrow: "Queryable Chatbot · Data intelligence",
      question: "Top 5 countries by annual HR tech spend",
      title: "Annual HR tech spend",
      unit: "USD, millions",
      bars: [
        { label: "United States", value: 412 },
        { label: "India", value: 318 },
        { label: "Germany", value: 241 },
        { label: "United Kingdom", value: 197 },
        { label: "Brazil", value: 154 },
      ],
      foot: "Verified against 5 rows from",
      source: "span_companies",
    },
  },
  lake: {
    id: "lake",
    name: "LakeB2B",
    productName: "LakeB2B Data Assistant",
    wordmark: ["LakeB2B", "Data Assistant"],
    tagline: "Enabling Growth",
    websiteUrl: "https://www.lakeb2b.com",
    logo: {
      light: "/brands/lake/LakeB2B_Logo_Transparent_720.png",
      dark: "/brands/lake/LakeB2B_Logo_Reversed_720.png",
      alt: "LakeB2B, Enabling Growth",
      width: 180,
      height: 51,
    },
    starters: [
      { displayText: "How many accounts use ADP?", prompt: "How many accounts use ADP?" },
      { displayText: "Accounts by payroll vendor", prompt: "How many accounts use each payroll vendor?" },
      { displayText: "ADP accounts by state", prompt: "Show the number of ADP accounts by state" },
    ],
    disclaimer: "The assistant can make mistakes. Check important figures against the query inspector.",
    welcome: "Ask about technology installs, accounts and markets in plain language. Every number comes straight from your LakeB2B data.",
    showcase: {
      eyebrow: "LakeB2B Data Assistant. Enabling Growth",
      question: "Which payroll vendors do our accounts use?",
      title: "Accounts by payroll vendor",
      unit: "accounts",
      bars: [
        { label: "Gusto", value: 27 },
        { label: "Paychex", value: 26 },
        { label: "ADP", value: 25 },
      ],
      foot: "Sample answer from",
      source: "tech_install_accounts",
    },
  },
  span: {
    id: "span",
    name: "SPAN Global Services",
    productName: "SPAN Data Assistant",
    wordmark: ["SPAN", "Data Assistant"],
    tagline: "Vertical Specialist Data Intelligence",
    websiteUrl: "https://www.spanglobalservices.com",
    // Only a dark-ink file is published; it never goes on a dark ground.
    logo: { light: "/brands/span/span-logo.png", dark: null, alt: "Span Global Services", width: 140, height: 40 },
    starters: [
      { displayText: "Oracle companies in North America", prompt: "How many companies use Oracle in North America?" },
      { displayText: "Oracle install base by region", prompt: "How many companies use Oracle in each region?" },
      { displayText: "Top technologies in EMEA", prompt: "Which technologies are used by the most companies in EMEA?" },
    ],
    disclaimer: "The assistant can make mistakes. Check important figures against the query inspector.",
    welcome: "Ask about technology adoption by region, industry and company size. Every number comes straight from your SPAN data.",
    showcase: {
      eyebrow: "SPAN Data Assistant. Vertical Specialist Data Intelligence",
      question: "Where are the companies that use Oracle?",
      title: "Oracle install base by region",
      unit: "companies",
      bars: [
        { label: "North America", value: 222496 },
        { label: "EMEA", value: 74044 },
        { label: "APAC", value: 54299 },
        { label: "LATAM", value: 19745 },
      ],
      foot: "Sample answer from",
      source: "tech_totals",
    },
  },
};

const raw = process.env.NEXT_PUBLIC_BRAND;
export const BRAND: Brand = raw === "lake" || raw === "span" ? BRANDS[raw] : BRANDS.neutral;
