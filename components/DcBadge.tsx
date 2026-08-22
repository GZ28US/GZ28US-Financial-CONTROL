'use client'

import StageBadge from '@/components/StageBadge'
import { DC_STAGE, DC_VERSION } from '@/lib/dcVersion'

export default function DcBadge() { return <StageBadge stage={DC_STAGE} version={DC_VERSION} /> }
