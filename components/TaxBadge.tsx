'use client'

import StageBadge from '@/components/StageBadge'
import { TAX_STAGE, TAX_VERSION } from '@/lib/taxVersion'

export default function TaxBadge() { return <StageBadge stage={TAX_STAGE} version={TAX_VERSION} /> }
