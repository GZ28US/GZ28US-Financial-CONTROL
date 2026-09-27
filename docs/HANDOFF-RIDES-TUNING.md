# HANDOFF — sessão local «Rides Tuning» → sessão cloud «Rides tuning»

Escrito em **27/09/2026 02h45 Orlando** (`node scripts/agora.mjs`) pela sessão local «Rides Tuning» (Claude Code desktop, máquina do Márcio).
Carro do trabalho: **HellMonster — hoje US.037 (era US.040 até a renumeração da frota de 27/09 01h59)** — 2024 RAM 1500 TRX, VIN 1C6SRFU91RN140799.

> **Leia primeiro:** esta tarefa NÃO é código do app. O trabalho é calibração no **HP Tuners VCM Editor 5.3.1003 (Beta)**, instalado SÓ na
> máquina Windows do Márcio, operado por computer-use; os arquivos `.hpt` (tunes) e `.hpl` (logs) vivem no **Dropbox local**, não no Git.
> A sessão cloud não consegue abrir o VCM Editor nem os `.hpt`. O que dá pra fazer na cloud: análise de log (CSV exportado), cálculo de
> tabelas (TSV), pesquisa, planejamento, texto pro João. Tudo que é «colar no Editor» precisa de uma sessão LOCAL com computer control ligado.

Material de apoio neste repo: `docs/rides-tuning/` (scripts Node, tabelas TSV do R9/R10, remaps da reescala 7.500, auditoria condensada do R9 LOG,
channel list do Scanner). Nada disso é usado pelo app.

---

## a) OBJETIVO — o que o Márcio pediu (frases LITERAIS, hora Orlando)

**Missão da sessão (24/09):**
- 24/09 22:37 — «I want to find a way you tune a car using HP Tuners»
- 24/09 22:50 — «did you understand what I need? I want to give you the bonestock file of the car, tell you the mods, and you build the new modded tune for me.»
- 24/09 23:07 — «here you go the file, open this one, create a new file to do the mods. Look at its build sheet in the app to know whats done.» · «don't use the HB TUNING folder, use the folder I gave you»
- 24/09 23:12 — «GoldenEye is not a success case» (US.001 GoldenEye NÃO é receita)
- 24/09 23:16 — «you have to put all the new injectors infos and do the mods required for aftermaket cams, see the buildsheet of the car. You have to know what to do,»
- 24/09 23:59 — «not the lockout, the limiter» (cam HHP com LIMITER de 14°)
- 25/09 00:01 — «no flex command in the tune, it doesn't work»
- 25/09 00:02 — «forget about the E85» · «It will be tuned in 93 gasoline»
- 25/09 00:07 — «no boost limits, once it's the D170 blower with an agressive pulley combination»
- 25/09 00:19 — «you're the one who will tell me the torque limits, the 105mm TB data you can get in a D170 bonestock file, we have several. Don't forget to save your work all the time,»
- 25/09 14:46 — «the car is running on a 4x2 dyno, without the front driveshaft and ABS fuses out»
- 25/09 16:57 — «veja as msgs do Joao, log na pasta, faça a nova revisão, assim qu estiver pronta, avise ele no pvt, não espere por comando meu» (valeu SÓ naquele ciclo)

**Câmbio (26/09):**
- 26/09 19:25 — «…he says about the transmission, we should do the tune mods so it handles more power, and it would be great if you applied there a tune to make the transmission behave like a BMW M3 ZF8HP, for example, I know it's possible. But you can take care of that later, if you prefer.»
- 26/09 19:55 — «use mimimal possible torque converter slip when the car is driving, moving, and the max possile slip when engaged in braked. I'm not talking about max an min table values, I'm talking about max and min plausible values. So it shifts consistent when driving and smooth when braked in a sign, for example. And we have more bonestock files in the folder TUNE REPOSITORY, you can find them there.»
- 26/09 20:17 — «falou se é pra ele gravar só ECM ou ECM e TCM? Info inportante. Write Calibration só ou write entire? Creio que só calibration.»

**Log / sondas / mistura (26/09):**
- 26/09 22:02 — «não temos wideband no dyno, remova isso, as sondas do carro são novas e originais, confiáveis»
- 26/09 22:31 — «olhe as msgs do Joao, ele disse que estão quse morrendo lá de tao rica, trabalhe assertivamente nisso, já tente chegar mais próximo do ponto certo no próximo mapa…»
- 26/09 22:33 — «Tente evoluir ao máximo nesta revisão, vamos encurtar o número de revisões, pense mais, pra ser mais assertiva. DO IT!»
- 26/09 23:56 — «de novo, seja inteligente e precisa! Tente evoluir ao máximo nesta revisão, faça as alterações com precisão!»

**Escala 7.500 rpm:**
- 26/09 22:51 — «outra coisa, não é certo vc aumentar as escalas das tabelas, pra 7500rpm? Não pra agora, mas ao final, vou querer girar 7000rpm até as trocas de marcha em wot, DEPOIS ao final»
- 26/09 23:01 — «i believe we should have tables up to 7500rpm all around, that's the 1st mod I'd do.»
- 26/09 23:14 — «you're not supposed to increase any rpm limiter right now, not engine cut, shift points, nothing, if we'll do that, that'll be later. I just want the tune to COVER up to 7500rpm, IN CASE we go there»
- 26/09 23:16 — «ve should go up to 7500 as well, independent if we'll go there or not»
- **27/09 02:23 — «don't you have transmission tables to reescale too? Register that this 7500 all-table conversion is STANDARD in our tuning, you will do it 1st of all from the 1st base tune in all our Mopar tunes, SACRED RULE. IT'S VERY IMPORTANT that we start from a base tune capable of reading and manipulate everything until 7500rpm.»**

**Qualidade / lenta (27/09):**
- 27/09 00:08 — «always fix whatever you catch for the next revision, so, fix it now, in the R11, I told Joao not to install it until you do it. SEJA ACERTIVA e PRECISA, vamos deixar este carro PERFEITO!!!! PERFEITO!!!!!!!! Funcionando bem como se fosse de fábrica!»
- 27/09 00:12 — «the spark, specially in idle, should neve stay below 7.5 degrees, if it does, the headers linghten! Fire danger!»
- 27/09 00:17 — «the spark can go very negative, no problem, but for a short period of time only»
- 27/09 00:18 — «the goal is to keep the lambda and timing readings as stable as possible»

**Nome da revisão (27/09):**
- 00:57 — «let's do this, Dyno sessions over for tonight, ok, Build the next revision already with ALL AUDITED and PRECISE fixes and already with the 7500rpm tables…»
- 00:58 — «call it R10, as it's supposed to be, once we haven't installed R11 and logged yet. So, next pERFECT revision: R10» · 01:13 «R10» · «não r11»
- 01:12 — «eu vou deixar o PC ligado e dormir agora, logo, não pare em hipótese nenhuma enquanto não tiver finalizado o R10, como conversamos, com absolutamente todas as correções do R9 e já no formato das tabelas na escala nova de 7500rpm…» · «AUDITE TODOS OS ERROS do R9 e já solte o R10 com todas as correções!»

**Última ordem (27/09 02:23) — ainda em aberto:**
> «I'd like you to search the web for all possible documentation for Late HEMI Gen3 Mopar HP Tuning! HP Tuners, Tuner School, everywhere, I want you to become THE BEST HEMI TUNER OF THE WORLD! Are you sure this R10 revision has already everything fixed from the R9, audit it again, engine & transmission, I want this revision to be VERY ADVANCED AND PRECISE! Remember I want the transmission to behave like the BMW Ms, the tuned ones, very sporty shifts, with the sound and experience of these cars, with a fire shot in the wot gear shifts, if you can! … Learn the best techniches to tune VVT, injectors phase/timing, spark timing, fueling, fuel pressure, everything, I want this RAM to be THE BEST RAM of the world!!!! And answer me a question, if bonestock it makes 700bhp, howm much she's supposed to make with this setup? Withe the Demon 170 3.0L full blower with an agressive combination of pulleys, the cam and headers? Tell me, do the math, I don't want a guess, I want a precise answer.»

---

## b) FEITO

**Commits:** nenhum desta sessão até este handoff (o trabalho é em `.hpt` fora do Git). **SQL/migration:** nenhum. **data_fixes:** nenhum.
**Leituras de banco (read-only):** `ride_build_sheets`, `dyno_pulls`, `rides` no Supabase US (DataBank) — ver seção e/h.

**Revisões do tune** (pasta `C:\Users\gz28u\Dropbox\001 - GZ28US\GZ28US Mkt\Claude\Experiment\HM\`, arquivos `HM Z1250sc GOLDENEYE PACK Rn.hpt`):

| Rev | Salva (Orlando) | O que tem | Gravar |
|---|---|---|---|
| R1 | 24/09 23:56 | bicos ID1750XDS (planilha oficial ID), cam HHP SS c/ limiter 14° (Exh Max-Phase/Min 121), boost sem limite (Max Target MAP 400 kPa), torque no teto do OS (967 / 1.022 hp), TB 105 mm (35035 do D170) | ECM |
| R2 | 25/09 14:52 | VE por trims (inútil: NN ativa) + PRatio Max 2,60 | ECM |
| R3 | 25/09 ~16h | **Neural Network OFF** (VE passa a valer) | ECM |
| R4 | 25/09 16:30 | vapor-lock mínimo 450→350/400 kPa; VE 2ª passada (errada — corrigida depois) | ECM |
| R5 | 25/09 17:12 | rear O2 fora da malha (Adapt Lo/Hi 0/0, CL Enable ECT Rear 376 °F); alvo D 688→776; reserva D/R 11→22 | ECM |
| R6 | 25/09 17:45 | Control Goal FAR ×0,93 (ERRO — desfeito na R7) | ECM |
| R7 | 26/09 20:12 | TCM: Max Torque 959 (valores D170), TCC maps 1–8 travam cedo; goal FAR de volta | **ECM+TCM** |
| R8 | 26/09 21:54 | só TCM: TCC maps 51–60 (padrão 10) travam cedo | ECM+TCM |
| R9 | 26/09 23:00 | VE por wideband×trims (47 cél/banco), DFCO 1.600/1.300 | ECM — **último no carro** |
| R11 | 27/09 00:25 | **OBSOLETA** (nunca gravada; virou a base da R10) | — |
| **R10** | **27/09 02:12** | **REVISÃO ATUAL, pronta, NÃO enviada** — ver abaixo | ECM |

**Conteúdo da R10 (vs R9) — conferido por Compare R10×R9 + Ctrl+5 (lista só o previsto; «DTC list» e «Baro Spark» = artefato/eixo):**
1. Trim cells: Fuel Trim Cell PRatio Boundaries 0,35/0,50/0,60/0,75/0,90 → **0,25/0,36/0,50/0,75/0,90**.
2. Lenta: Target Idle P/N **1000/984/896/880/880** (ECT −4/50/95/140/194 °F); Target Drive **1000/984/848/816/816** (Editor quantiza 16 rpm); Idle Torque Spark Proportional P/N **×0,5**; Idle Reserve Torque D/R **14/8/10/10/0** (680/750/1000/1400/2000); P/N **2/2/2/1/0** (680/1000/1400/1704/2000).
3. **Catalyst Reserve Surface = 0 em tudo** (reserva de aquecimento de catalisador; carro sem cat; causava 45–70 s de spark −4° pós-partida e até 52 lb-ft de atraso rodando frio).
4. **Friction Temp Modifier** +16/+16/+13/+6/0 lb-ft em 700/750/950/1100/≥1300 rpm nas linhas 176/212/248 °F (140 °F = metade) — corrige o modelo de torque que superestima ~20 lb-ft na lenta com esse cam (integral de ar, cap 26, saturava → lenta D 37 rpm abaixo e buraco de ar no pedal leve = causa dos apagões R3/R4).
5. Spark PT Lockpin [0,24 g × 1.152] 14 → 24 (buraco).
6. VE (tabelas em `docs/rides-tuning/tables/ve/ve?_R10v2.tsv`): linha PR 0,90 (tip-in pobre, +2…+41%), linha 0,40 B1 1.312/1.664 ×0,956/0,960 e B2 ×0,975/0,976, 0,75/1.664 = R9×1,09, 0,55/1.984 = R9 (B1)/R9×1,005 (B2), linha 1,10 ≥ linha 0,90 em 1.152–2.464.
7. Tip-in: Fuel Based Accel Enrichment Gain e Throttle Based Accel Enrichment Gain **×1,4** só nas linhas 176/203 °F até ~2.500/2.816 rpm.
8. **Reescala 7.500 do ECM completa**: VE (+VE Max RPM 7.500, PRatio Max 3,0), spark PT/WOT/MBT/Thermal (40 tabelas c/ variantes), PE, 6 de came, knock threshold cil 1–8, Knock LT Max Retard, Knock Filter, Max/Min Knock Sensor Voltage, **Injector PW Limit** (1.600/2.816/3.904/5.088/7.488 = 72,5/41/29/22/14,5 ms), **Friction Torque** (extrapolado), Friction Temp Modifier, Port Flow, **Supercharger Airflow** (extrapolado), **Exhaust Temp RPM vs MAP** (extrapolado). Cauda plana (hold já cobre): RPM Mult cil 1–8, Knock Max Retard, MAP LT knock mult, FA knock enrich, dwell, indicated torque, WOT throttle setpoint, accel gain (5.504).
9. **Revertidos após verificação**: Idle Torque Spark Derivative P/N, Friction Engine Warm Up, Startup Airflow (= R9).

**Workflows rodados** (journals locais, não no Git): auditoria do R9 LOG `wf_44b6bd6f-508` (9 dimensões + 80 vereditos; 55 verificadores e o crítico falharam por limite semanal da conta) — resumo em `docs/rides-tuning/AUDITORIA_R9_RESUMO.md`. Pesquisa web `wf_9414db94-d7f` e re-auditoria R10 `wf_244492ba-011`: **falharam inteiras** (limite semanal, «resets 8am America/New_York»).

**Rollback:** não há rollback de banco (nada foi escrito em banco). Rollback de tune = gravar o `.hpt` anterior (R9 é o que está no carro).

---

## c) NÃO FEITO — em ordem, com o próximo passo

1. **TCM: reescala 7.500** (ordem 27/09 02:23). Precisa sessão LOCAL com computer control (foi DESLIGADO em Settings às ~02:29). Passo: abrir R10 no VCM Editor → Trans → varrer abas General/Manual/Shift General/Shift Scheduling/Shift Pressures/Shift Timing/Torque Converter/Torque Management; toda tabela com eixo de rpm do MOTOR ou TURBINA terminando < 7.500 → remapear (recipe na seção g). **Não mudar ponto de troca nem limitador** (valores iguais; só cobertura). Se mexer no TCM, a gravação da R10 passa a ser **ECM+TCM**.
2. **Re-auditoria da R10 (motor+câmbio)** que ele pediu às 02:23 — o workflow falhou; refazer (script local `hm-r10-reaudit-engine-trans`; dimensões: ledger de cada achado do R9, red-team da lenta/modelo de torque, red-team de combustível, checagem numérica da reescala, câmbio/plano BMW-M, prontidão WOT, red-team geral). Pode rodar na cloud se os CSV dos logs estiverem acessíveis (ver h).
3. **Pesquisa web + «bíblia» Hemi Gen3/GPEC2A/ZF 8HP** (7 temas: arquitetura GPEC2A, spark/knock/fuel 93 e E85, VVT, bicos/injeção/pressão, TCM ZF8HP estilo BMW M + «pops» na troca WOT com segurança, plataforma TRX, processo/Tuner School). Pode rodar 100% na cloud.
4. **Cálculo de potência** (pergunta das 02:23, «do the math»): modelo de ar do blower (3,0 L × rotação pela relação de polias × eficiência → lb/min → hp − arrasto do blower), calibrado nos NOSSOS dynos (seção e) e cruzado com escala por carros-irmãos; responder 93 e E85 com faixa. Pode rodar na cloud (DataBank via Supabase US).
5. **Plano do câmbio «BMW M»** (trocas curtas/firmes, corte de torque por ignição na troca, rev-match na redução, TCC travado cedo, «fire shot» na troca WOT se seguro). Depende de (1) e de ordem dele pra mexer em ponto de troca.
6. **Mensagem ao João** com a R10 — rascunho pronto abaixo (seção i); **NÃO enviar sem «manda»**; e só depois de fechar (1)/(2) se ele quiser a R10 com TCM.
7. **R10 LOG** (quando o João gravar): protocolo novo — armar o monitor de misfire com coast ≥15 s ANTES da lenta; pós-partida 90 s; lenta P/N/D + A/C + volante; 3× N→D, 3× P→D, 1× N→R; 3 saídas sem pedal, 3 com ~5%, 3 com 10–15%; aceleração leve até 6ª; patamares 1.500/2.000/2.500 em 6ª com coast até parar; 3 retomadas 4ª ~1.500 rpm pedal 30% sem boost; 5 blips em N; sem boost/WOT. Critérios: spark de lenta com média ≥ 9° e média móvel 2 s ≥ 7,5° em ≥95% do tempo; creep/saída sem cair < ~650 rpm; λ de cruzeiro 0,98–1,00 e ST integrando abaixo de PR 0,50; pós-DFCO ≥ 0,95 em 3 s.
8. Depois: boost/WOT progressivo (parcial → pulls de 3ª), knock do banco 2 (sensor ruidoso), PE, VE ≥ 1,10, E85 futuramente.

---

## d) DECISÕES DELE (não rediscutir) e opções RECUSADAS

- **Gasolina 93**, sem E85 por ora; **nunca flex/inference** («no flex command in the tune, it doesn't work»).
- **Sem limite de boost** (Max Target MAP 400 kPa). **Torque** = decisão do tuner, no teto do OS.
- **Sondas do carro = verdade** (novas, originais). **Não existe wideband no dyno** — nunca sugerir sonda/sniffer externo.
- **LEI SAGRADA (27/09 02:23): 1º passo de TODO tune Mopar = TODAS as tabelas (ECM e TCM) cobrindo 7.500 rpm, já no tune base.**
- **NUNCA subir limitador / corte / ponto de troca** sem ordem explícita (reescala = cobertura, não mudança).
- **Spark de lenta sustentado ≥ 7,5°** (headers catless em brasa = fogo); negativo **breve** é OK. **Piso duro de spark (Min Idle Spark) REJEITADO.**
- Meta: **λ e timing o mais estáveis possível**, «como se fosse de fábrica».
- **Tudo que for achado no log entra na PRÓXIMA revisão** (nada fica pra depois).
- Próxima revisão = **R10** (R11 obsoleta, nunca gravada).
- **Gravação:** sempre dizer ao João QUAIS controladores (só ECM ou ECM+TCM) e **Write Calibration** (Write Entire só se mudar o OS).
- TCC: **mínimo slip plausível rodando, máximo slip plausível parado no freio**.
- Câmbio estilo **BMW M (ZF8HP tunado)** — «pode ser depois» (26/09 19:25), reforçado em 27/09 02:23.
- **Recusado/errado antes:** Control Goal FAR mais pobre (R6 — o PCM briga); VE por trims sem wideband (R4); decretar hardware por 1 canal (TIP = 0 é artefato do PID); usar GoldenEye (US.001) como receita; pasta HB Tuning.

---

## e) ARMADILHAS

- **Renumeração da frota (27/09 01h59):** HellMonster **US.040 → US.037**. Os códigos US.033 e US.036–045 viraram OUTROS carros (ex.: US.040 hoje = QuickSilver). Nos arquivos/mensagens antigos o HM aparece como US.040. Mapa completo no topo de `RECADOS.md` (recado de 27/09 01h35). Outros carros citados: SublimeHell US.042→**US.038**; HellBull US.037→**SC.062**; Devil170 US.170→**SC.170**; WhiteDevil US.002, Lucifer US.034, JailBreak170 US.035, HellCougar US.013, Alcatraz US.015, Colossus US.003 (não mudaram).
- **Neural Network** do airflow estava ATIVA: editar «VE Bank 1/2» não faz nada até **Use Neural Network = Disabled** (feito na R3).
- **Loop fechado não integra com PR < 0,50** (cruise leve/overrun): o λ ali é combustível BASE + ST «congelado» da última aceleração. R10 mudou as fronteiras das células para tentar ligar o integrador em 0,36–0,50 — **não provado** (pode ser um gate separado).
- **Após todo DFCO o ST vai a exatos +10,74% nos 2 bancos** (preset fixo, não é feedback) → ~6 s rico; o parâmetro NÃO foi achado no editor (buscado: DFCO, Closed Loop, Purge, Recover).
- **Monitor de misfire cego** até o 1º DFCO longo (≥12–15 s a partir de ≥1.500 rpm / ≥50 mph) — «0 misfires» no começo do log não prova nada.
- **Canais-lixo** no log: TIP = 0 kPa (PID não reporta nesse OS), O2 B1S2/B2S2 (sensores desligados; B1S2 lê temperatura), Rear O2 Correction, Default Goal Voltage, Equivalence Ratio Commanded (sempre 1); contadores de misfire cil 2/3/4/8 estouram (65.2xx). Export CSV do Scanner vem INTERPOLADO (todas as células preenchidas).
- **Eixo de reserva de lenta** = «Idle Speed» (provavelmente rpm DESEJADA, não real — não confirmado).
- **VCM Editor (quirks):** navigator maximizada abre 2ª navigator; janela de EIXO pode ficar aberta e receber o paste dos VALORES (aconteceu com Max Knock Sensor Voltage — corrigido); `type` do computer-use pode usar o clipboard (sobrescreve o que estava lá) — sempre reescrever o clipboard DEPOIS de digitar no filtro; diálogo «Parameter Out Of Range» trava batch; Editor quantiza (VE inteiro, rpm 16, ms 0,008). **Sempre fechar com Compare vs arquivo anterior + Ctrl+5 + Ctrl+4.**
- **DTC de emissão (P0420/P0430)** travados pelo Parameter Access da HPT (precisa device code da conta dele).
- **Dyno 4×2** sem cardan dianteiro/fusível do ABS → U-codes e «4WD Overheated» são disso.
- Os limites semanais da conta derrubaram 3 workflows às 02h35 (reset 8h Orlando).

---

## f) ARQUIVOS

- Tunes/logs (Dropbox local, fora do Git): `...\GZ28US Mkt\Claude\Experiment\HM\` — `HM BONESTOCK ALL CONTROLLERS.hpt`, `HM Z1250sc GOLDENEYE PACK R1…R11.hpt` (R10 = atual), logs `R1…R9 LOG.hpl`, channel lists `HM TRX CLAUDE R7/R8.Channels.xml`.
- BoneStocks de referência: `...\GZ28US Rides\BoneStock TuneRepository\` (40 arquivos; D170 com TCM = «MOPAR 23 … DEMON170 COLOSSUS ALL CONTROLERS BONESTOCK.hpt»).
- Neste repo: `docs/rides-tuning/`
  - `AUDITORIA_R9_RESUMO.md` — todos os achados + vereditos da auditoria do R9 LOG.
  - `scripts/` — `idlechk.mjs` (lenta P/N×D por log), `dtq.mjs` (torque/perdas/ar na lenta), `poststart.mjs` (pós-partida), `pnd.mjs` (spark × erro/derivada), `row90.mjs`, `merge11.mjs`, `vecorr_r9*.mjs` (correção de VE = λ×(1+ST)(1+LT)/0,993 bilinear), `xcorr.mjs`, `r8a.mjs`, `goalfar.mjs`, `stt.mjs` (transcrição Groq, lê a chave de arquivo local), `remap.mjs` + `clipremap.ps1` (reescala de eixo).
  - `tables/ve/` VE R9final e R10v2 (17×17; linhas PR 0,15…2,15; colunas rpm — R10 termina 4.416/5.008/5.600/6.192/6.784/7.488).
  - `tables/r10-rescale/` knock threshold cil 1–8 e LT max retard (orig × new). `tables/r10-fixes/` friction temp modifier (orig/R10), friction torque, port flow, supercharger airflow, exhaust temp (orig/new).
  - `tables/tcm/` exports dos TCC maps (R7/R8).
  - `HM TRX CLAUDE R8.Channels.xml` — channel list do Scanner (123 canais).
- Código do app: nenhum tocado.

---

## g) MEMÓRIA (cópia das memórias locais desta tarefa)

### Regras que valem
- **Hora sempre por `node scripts/agora.mjs`, fuso Orlando** (APIs devolvem UTC).
- **Nunca enviar mensagem sem «manda»/«send it» do Márcio.** Assinatura das msgs ao João: «— *Claudinha* 👩🏻‍💻». João = WhatsApp US `554396030009@c.us` (pvt). Eliel (staff) pvt `5512987042507`. Envio pelo MCP `wa_send` app US.
- **UMA pergunta por vez.** Falar inglês com ele por padrão (ele escreve PT/EN misturado).
- **Sempre dizer ao João quais controladores gravar e Write Calibration.**

### Recipe VCM Editor (computer-use)
- Abrir: `Start-Process 'C:\Program Files\HP Tuners\VCM Suite (Beta)\VCM Editor.exe' -ArgumentList '"<path>"'`; trazer à frente com SetForegroundWindow (PowerShell).
- Ler tabela: Ctrl+A → botão direito → «Copy with Axis» → ler clipboard (1ª linha = unidade+eixo colunas; linhas = eixo linha + valores).
- Escrever: clicar 1ª célula → Ctrl+A → Ctrl+V (TSV). Eixo: botão direito › Row/Column Axis › Edit → 1ª célula → Ctrl+A → Ctrl+V (linha TSV).
- Reescala: editar o eixo só re-rotula; os valores têm que ser REMAPEADOS por interpolação (`remap.mjs`); acima do fim antigo: hold se plano, extrapolar se cresce com rpm (atrito, fluxo do blower, EGT), recalcular se ∝ 1/rpm (Injector PW Limit). Breakpoints 17-col: …3.840, 4.416, 5.008, 5.600, 6.192, 6.784, 7.488.
- Parameter Navigator (Ctrl+N) tem filtro de texto (clicar, Ctrl+A, digitar, Enter; «Expand All» é o 2º ícone).
- Compare: Compare › Open Compare File; Ctrl+2 main, Ctrl+3 compare, Ctrl+4 diferenças, Ctrl+5 comparison log; Ctrl+L = histórico de saves.

### Doutrina GZ28 (aula do Márcio 07/08)
- Bicos não geram potência, só alimentam. **A potência «achada» vem da calibração de VVT** (Alcatraz: +77 WHP sem trocar peça).
- Cams de fábrica: Hellcat 717 bhp = Stg1 · Demon/Redeye 808 = Stg2 · **D170 900 bhp em 93** = Stg3. Motores idênticos em potência fora o comando; D170 ganha por chiller e giro.
- Overdrive por BAIXO (lower +10% ATI) > upper menor (upper D170 original é CLUTCHED; GripTec «seca» judia do blower). Polia sem header não se vende.
- Packs D170: Z1100 UnChained · Z1150 HellRaiser · Z1200 Demonized · Z1300 GoldenEye · Z1500 HellKing · Z1700 Apocalypse · Z2000 Typhoon · Z2500 Tornado. «Nada no limite» (ID1750 com folga).

### DataBank (Supabase US, tabelas `dyno_pulls`, `ride_build_sheets`, `rides`; US-origin = DynoJet STD wheel, bhp via loss_pct; BR-origin = ServiTec SAE ×1,04 = STD)
- **US.037 HellMonster** Build 1 (stock): **582,99 WHP / 702,4 BHP** (DynoJet GZ28US 17/08, loss 17%). Build 2 (sheet): D170 3.0L, upper D170 clutched 3,02", **lower ATI +10% OD**, HHP SS Stg1, Kooks 2×3", ID1750XDS, **fuel=E85 na planilha (o tune atual é 93)**, BAP, VVT limited.
- US.035 JailBreak170 (Hellcat 2,38L + upper 3,02" + ATI 10%, Kooks, 93, BAP): 717,9 → **976,3 BHP**.
- US.002 WhiteDevil (D170, 3,02" + ATI 10%, Kooks, E85): 1.025 → **1.078 BHP** (melhor).
- US.034 Lucifer (D170, GripTec 2,78", Kooks, E85): 1.022 → **1.151,7 BHP**.
- US.013 HellCougar (Redeye 2,7L + 3,02", HHP RaceRumble Stg3, Kooks, E85, BAP): **1.072,8 BHP**.
- US.015 Alcatraz (Durango Hellcat + D170 3,0L, 2,85", E85, BAP): 1.090 → **1.255,6 BHP** (dyno BR ArteCarros).
- BR.492 (Hellcat + D170 stock pulleys, HHP StreetRumble Stg2, Kooks, ID1750, E85): **1.296,5 BHP** (ServiTec BR).
- BR.530 (D170? GripTec 2,85", HHP Stg3 RR, Kooks, ID1300, E85): 1.108–1.138 BHP (BR).

### Histórico técnico completo
O conteúdo integral da memória `rides-tuning-hptuners-claude.md` (R1→R10, lições, IDs de parâmetros, canais) está resumido nas seções b/e acima; os pontos-chave por revisão:
R1 bicos/cam/boost/torque/TB · R2 VE por trims (NN ativa, inútil) · R3 NN OFF · R4 vapor lock + VE errada · R5 rear O2 fora, alvo D 776, reserva 22 (curou apagão R4) · R6 goal FAR −7% (errado) · R7 TCM 959 + TCC cedo · R8 TCC maps 51–60 · R9 VE por wideband, DFCO 1.600/1.300 · R10 (acima).
Descobertas do R9 LOG: loop não integra < PR 0,50; ST +10,74% pós-DFCO; spark de lenta −1° D / 0,8° P/N por causa da reserva 22/15; cat-heating reserve pós-partida; modelo de torque +20 lb-ft na lenta; misfire P/N ~700–800/min armado (ciclo de spark 2 Hz, some > ~850 rpm); coast em marcha 690–830 rpm concentra misfire; transientes: tip-in pobre na linha PR 0,90, tip-out rico, overrun rico antes do DFCO (wall film).

---

## h) ACESSO

- **Supabase US** (projeto `fvgpkbpqacnqxtrjsmpi`) e **BR** (`saaowriaptbvfoqoykrh`): na máquina local as service keys ficam em `~/.claude/projects/<projeto>/memory/us-service-key.txt` e `br-service-key.txt` (formato `sb_secret_…`; ler dentro do script, NUNCA por argv). Na cloud: use as variáveis de ambiente que a cloud tiver (`SUPABASE_SERVICE_ROLE_KEY` / `NEXT_PUBLIC_SUPABASE_URL` do app US). Tabelas do DataBank: `dyno_pulls`, `ride_build_sheets`, `ride_builds`, `rides` (coluna do código = `project_code`).
- **Groq (transcrição de áudio do WhatsApp):** chave local em `memory/groq-key.txt` (script `stt.mjs`).
- **WhatsApp:** MCP `whatsapp` (`wa_messages`, `wa_send` app US). João `554396030009@c.us`.
- **Dropbox:** os `.hpt`/`.hpl` estão no Dropbox da conta GZ28US (`/001 - GZ28US/GZ28US Mkt/Claude/Experiment/HM/`). A cloud só chega lá via API do Dropbox do app (`/api/ride-folder` usa o token do app — variável de ambiente do Vercel). Para analisar log na cloud: exportar o `.hpl` para CSV (só o VCM Scanner exporta — máquina local: Log File › Export Log File › CSV, Entire Log).
- **HP Tuners VCM Suite (Beta) 5.3.1003**: só na máquina local; **computer control estava DESLIGADO** às 02:29 de 27/09.

---

## i) PERGUNTAS EM ABERTO pro Márcio (uma de cada vez)

1. A R10 vai pro carro só ECM **já**, ou espera eu fechar a reescala do TCM (aí vira ECM+TCM)?
2. Religar o computer control (Settings) na máquina local para terminar o TCM — ou a cloud segue só com pesquisa/cálculo?
3. O build sheet do HM diz **E85**; o tune é **93**. A resposta de potência sai nos dois — confirmar qual combustível vale para o pack.
4. Plano BMW-M: ele autoriza mexer em pontos de troca/tempo de troca (hoje proibido sem ordem)?

**Rascunho pronto ao João (NÃO enviado — precisa «manda»):**
> *HM — R10 pronta* ✅ — *a R11 NÃO vale, não grava ela* · Arquivo *HM Z1250sc GOLDENEYE PACK R10.hpt* (pasta HM) · *Gravar: só ECM — Write Calibration* (TCM igual ao R8) · O que muda: spark de lenta ≥ 7,5° (reservas D 8–10 / P/N 2; alvo quente P/N 880 e D 816); aquecimento de catalisador desligado (pós-partida); modelo de torque da lenta corrigido (lenta em D no alvo, sem buraco no pedal leve); VE refinada, células de trim novas, tip-in +40% quente; tabelas cobrindo 7.500 rpm, nenhum limitador mexido. · Log R10: (protocolo da seção c.7). Sem boost e sem WOT. Salvar como *R10 LOG*. — *Claudinha* 👩🏻‍💻
