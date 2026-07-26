// Approved WhatsApp templates.
// IMPORTANT: these `name` + `language` values must EXACTLY match templates you
// created and got APPROVED in Meta Business Manager / MSG91 (Message Templates).
// `params` are the body variables {{1}}, {{2}}... in order — the backend fills them
// from the lead automatically (name -> lead.name, loan -> loan label, city, amount).
// `preview` is only for showing the agent what the message looks like in the CRM.

export const WHATSAPP_TEMPLATES = [
  {
    // 1) FIRST OUTREACH — send this to a fresh lead. Introduces Saarathi and links the form.
    name: "opening_blast",
    label: "Intro + form link (first message)",
    language: "en",
    params: ["name"],
    preview:
      "*Dear {{1}}*,\nLooking for a loan? We are here to help.\nWe offer *Personal Loan*, *Home Loan*, *Business Loan*, *Car Loan*, *Gold Loan* and *Loan Against Property* — with quick processing, minimal paperwork, and friendly guidance at every step.\nApply now in just 1 minute and our executive will reach out to you shortly.\n_T&Cs apply._\n👉 *Apply now:* https://sarathi-associates.netlify.app/",
  },
  {
    // 2) AUTO ACKNOWLEDGEMENT — sent automatically the moment someone submits the form.
    name: "application_ack",
    label: "Application acknowledgement (auto after form)",
    language: "en",
    params: ["name", "loan"],
    preview:
      "Hi {{1}}, thank you for submitting your {{2}} enquiry with Saarathi Associates. Our team has received your details and will get back to you shortly. You can reply to this message anytime if you have any questions.",
  },
  {
    // 3) FOLLOW-UP nudge for leads who went quiet.
    name: "loan_followup",
    label: "Follow-up nudge",
    language: "en",
    params: ["name"],
    preview:
      "Hi {{1}}, just following up on your loan enquiry with Saarathi Associates. If you're still interested, reply here and our team will guide you through the next steps.",
  },
  {
    // 4) Documents request (transactional / Utility).
    name: "docs_request",
    label: "Documents request",
    language: "en",
    params: ["name"],
    preview:
      "Hi {{1}}, to move your loan application forward we need a few documents from you. Reply to this message and our team will share the exact list and help you complete it.",
  },
];
