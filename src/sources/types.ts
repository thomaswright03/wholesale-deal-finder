export interface Listing {
  id: string;
  address: string; // street line
  city: string;
  state: string;
  zip: string;
  propertyType: string;
  listingType?: string;
  price: number;
  beds?: number;
  baths?: number;
  sqft?: number;
  yearBuilt?: number;
  monthlyHoa?: number;
  daysOnMarket?: number;
  listedDate?: string;
  agentName?: string;
  agentPhone?: string;
  agentEmail?: string;
  officeName?: string;
  url?: string;
  // Filled in by enrichment (rent estimate + tax record), or straight from a CSV
  monthlyRent?: number;
  rentLow?: number;
  rentHigh?: number;
  rentSource?: string; // "Property Genie", "HUD FMR 2027", "RentCast", ...
  annualTax?: number;
  taxEstimated?: boolean;
  taxSource?: string; // e.g. "Hamilton County Auditor, 2025 Payable 2026"
  annualInsurance?: number;
  value?: number; // RentCast value estimate, used as after-repair value (ARV)
}
