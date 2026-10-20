// ParkNear configuration — Live Mode (Supabase).
// The anon key is safe to publish in frontend code; row-level policies in
// supabase-schema.sql control access. Project: parknear (us-east-1, Free).
window.PARK_CONFIG = {
  supabaseUrl: "https://wqihvxzmpmxbzkopjkzl.supabase.co",
  supabaseAnonKey: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6IndxaWh2eHptcG14Ynprb3Bqa3psIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTI1MDk4OTQsImV4cCI6MjEwODA4NTg5NH0.I9Qnpo4bmlhdjpaLBZ3zom0G-T8yNbKZdUDZCgr6jTA",
  // Automatic detail emails via EmailJS (connected 2026-10-20): free account
  // under karmendra8386@gmail.com, Gmail service "ParkNear Gmail" sends from
  // his Gmail. The public key is designed to be embedded in frontend code.
  emailjs: { publicKey: "a2hLXf-w6Rhvu8ho5", serviceId: "service_bfvbe4o", templateId: "template_ziicn5x" },
  // Admin page (#/admin) gate: SHA-256 hash of the admin PIN. Empty = admin
  // page stays locked until the owner sets a PIN.
  adminPinHash: "a5266239ab5a99c8456d926461b67c9953887f857fd3a7d86dc399e5012b9a5d"
};
