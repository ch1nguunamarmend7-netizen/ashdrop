// Details that appear on the Terms, Privacy and Contact pages.
// Fill in `operator` and `country` before launch. Until both are set, those pages show a
// "Draft" notice so nobody mistakes them for final.

export const SITE = {
  name: 'Ashdrop',
  domain: 'ashdrop.cc',
  operator: 'Chinguun',             // legal name of the person or company that runs Ashdrop
  country: 'Mongolia',              // where that person or company is based; its law governs the Terms
  contactEmail: 'helloashdrop.cc@gmail.com', // general questions, privacy requests, security reports
  abuseEmail: 'helloashdrop.cc@gmail.com',  // reports of links that break the Terms
  minAge: 16,
  updated: '2026-10-19',            // change whenever you edit the Terms or Privacy text
};

export const LEGAL_IS_DRAFT = !SITE.operator || !SITE.country;
