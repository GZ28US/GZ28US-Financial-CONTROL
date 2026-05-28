// Re-uses the same invoices LIST page as rides. The page itself detects
// client vs ride context from the URL (usePathname), so this thin wrapper
// is all that's needed to serve /clients/[id]/invoices.
export { default } from '@/app/rides/[id]/invoices/page'
