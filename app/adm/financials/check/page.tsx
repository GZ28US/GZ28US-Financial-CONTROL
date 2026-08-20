// DATA CHECK morava aqui dentro do FINANCIAL; promovido a ferramenta de
// organização do app inteiro (ADM → DATA CHECK, ordem do Márcio 20/ago).
// Este stub só redireciona quem tinha o caminho antigo salvo.
import { redirect } from 'next/navigation'

export default function OldDataCheckPath() {
  redirect('/adm/check')
}
