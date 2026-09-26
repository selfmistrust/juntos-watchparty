import Head from 'next/head';
import { Shield, Gavel, FileText, Users, Envelope, Warning, CheckCircle } from '@phosphor-icons/react';
import { Button } from '@/components/ui/Button';
import Link from 'next/link';

export default function TermsOfService() {
  const lastUpdated = '24 de setembro de 2026';

  return (
    <>
      <Head>
        <title>Termos de Serviço | juntos</title>
        <meta name="description" content="Termos de Serviço do juntos — plataforma de watchparty com vídeo sincronizado." />
        <meta name="robots" content="index, follow" />
      </Head>

      <main className="mx-auto max-w-4xl px-6 py-12 sm:px-10">
        <header className="mb-12 text-center">
          <h1 className="font-display text-3xl sm:text-4xl font-semibold tracking-tight text-ink">
            Termos de Serviço
          </h1>
          <p className="mt-3 text-sm text-ink-muted">
            Última atualização: <time dateTime="2026-09-24">{lastUpdated}</time>
          </p>
        </header>

        <article className="space-y-10 text-base leading-relaxed text-ink/90">
          {/* 1. Aceitação */}
          <section>
            <h2 className="flex items-center gap-2 text-lg font-semibold text-ink">
              <FileText size={20} weight="fill" className="text-accent" />
              1. Aceitação dos termos
            </h2>
            <p className="mt-3">
              Ao acessar ou usar o <strong>juntos</strong> (&ldquo;Serviço&rdquo;, &ldquo;Plataforma&rdquo;, &ldquo;nós&rdquo;),
              você (&ldquo;Usuário&rdquo;, &ldquo;Vocês&rdquo;) concorda com estes Termos de Serviço (&ldquo;Termos&rdquo;),
              nossa <Link href="/privacy" className="text-accent hover:underline">Política de Privacidade</Link> e
              quaisquer diretrizes da comunidade publicadas. Se não concordar, não use o Serviço.
            </p>
          </section>

          {/* 2. Descrição do serviço */}
          <section>
            <h2 className="flex items-center gap-2 text-lg font-semibold text-ink">
              <Shield size={20} weight="fill" className="text-accent" />
              2. Descrição do serviço
            </h2>
            <p className="mt-3 text-ink-muted">
              O juntos é uma plataforma de <strong>watchparty</strong> que permite:
            </p>
            <ul className="mt-3 list-disc list-inside space-y-2 text-ink-muted">
              <li>Criar salas privadas ou públicas para assistir a vídeos sincronizados</li>
              <li>Chat em tempo real (texto, GIFs, imagens comprimidas)</li>
              <li>Fila colaborativa (links YouTube, arquivos .mp4/.webm enviados para bucket S3/R2)</li>
              <li>Reações flutuantes e efeitos sonoros locais</li>
              <li>Busca no YouTube usando <em>sua própria</em> conta Google (OAuth, opcional)</li>
            </ul>
            <p className="mt-3 text-ink-muted">
              O Serviço é fornecido &ldquo;como está&rdquo; e &ldquo;conforme disponibilidade&rdquo;, sem garantias
              de uptime contínuo, ausência de bugs ou compatibilidade com todo conteúdo.
            </p>
          </section>

          {/* 3. Contas e identidade */}
          <section>
            <h2 className="flex items-center gap-2 text-lg font-semibold text-ink">
              <Users size={20} weight="fill" className="text-accent" />
              3. Identidade e contas
            </h2>
            <ul className="mt-3 list-disc list-inside space-y-2 text-ink-muted">
              <li><strong>Sem cadastro obrigatório:</strong> você entra na sala com um nome de exibição e avatar gerado (DiceBear)</li>
              <li><strong>Persistência local:</strong> nome, cor, avatar ficam no <code className="font-mono text-xs bg-hover px-1 rounded">localStorage</code> do seu navegador</li>
              <li><strong>Conexão YouTube (opcional):</strong> OAuth 2.0 com escopo <code className="font-mono text-xs bg-hover px-1 rounded">youtube.readonly</code>; tokens criptografados no servidor, nunca no navegador</li>
              <li><strong>Você é responsável</strong> por manter seu dispositivo/segurança de sessão (cookie <code className="font-mono text-xs bg-hover px-1 rounded">juntos_sid</code>)</li>
            </ul>
          </section>

          {/* 4. Conduta do usuário */}
          <section>
            <h2 className="flex items-center gap-2 text-lg font-semibold text-ink">
              <Gavel size={20} weight="fill" className="text-accent" />
              4. Conduta aceitável
            </h2>
            <p className="mt-3 text-ink-muted">
              Ao usar o Serviço, você concorda em <strong>não</strong>:
            </p>
            <ul className="mt-3 list-disc list-inside space-y-2 text-ink-muted">
              <li>Publicar conteúdo ilegal, difamatório, assediador, hate speech, pornografia infantil, terrorismo</li>
              <li>Violar propriedade intelectual (copyright, marcas) — use apenas conteúdo que você tem direito de compartilhar</li>
              <li>Tentar quebrar a sincronização, injetar código, fazer engenharia reversa, DoS, scraping automatizado</li>
              <li>Usar a conta Google de outra pessoa sem autorização para conectar ao YouTube</li>
              <li>Enviar spam, flood, mensagens repetitivas ou abusar de rate limits</li>
              <li>Compartilhar senhas de salas privadas com não autorizados</li>
            </ul>
            <p className="mt-3 text-ink-muted">
              Reservamo-nos o direito de remover conteúdo, expulsar usuários ou encerrar salas que violem estes termos,
              sem aviso prévio.
            </p>
          </section>

          {/* 5. Conteúdo de terceiros */}
          <section>
            <h2 className="flex items-center gap-2 text-lg font-semibold text-ink">
              <Warning size={20} weight="fill" className="text-accent" />
              5. Conteúdo de terceiros (YouTube, GIPHY, Tenor, uploads)
            </h2>
            <ul className="mt-3 list-disc list-inside space-y-2 text-ink-muted">
              <li>Vídeos YouTube são incorporados via <strong>IFrame API oficial</strong>; respeitamos restrições de embed/região/idade do YouTube</li>
              <li>GIFs vêm de GIPHY/Tenor via proxy no backend; sem chave de API, a busca é desabilitada</li>
              <li>Arquivos .mp4/.webm enviados vão direto do navegador para seu bucket S3/R2 (presigned URL); nós não hospedamos nem inspecionamos o conteúdo</li>
              <li><strong>Não assumimos responsabilidade</strong> por legalidade, precisão ou disponibilidade de conteúdo de terceiros</li>
              <li>Denúncias de copyright (DMCA/LDA): <a href="mailto:dmca@juntoswatchparty.vercel.app" className="text-accent hover:underline">dmca@juntoswatchparty.vercel.app</a></li>
            </ul>
          </section>

          {/* 6. Propriedade intelectual */}
          <section>
            <h2 className="flex items-center gap-2 text-lg font-semibold text-ink">
              <CheckCircle size={20} weight="fill" className="text-accent" />
              6. Propriedade intelectual do juntos
            </h2>
            <ul className="mt-3 list-disc list-inside space-y-2 text-ink-muted">
              <li>A marca <strong>juntos</strong>, logotipo, código-fonte, design, UI/UX são propriedade dos criadores</li>
              <li>Licença: código aberto sob <a href="https://github.com/seu-usuario/juntos-watchparty" target="_blank" rel="noopener" className="text-accent hover:underline">MIT License</a> (ou a que você escolher)</li>
              <li>Você pode usar, modificar, distribuir o código respeitando a licença</li>
              <li>Não concedemos licença para usar a marca/logotipo em produtos derivados sem permissão por escrito</li>
            </ul>
          </section>

          {/* 7. Isenção de garantias */}
          <section>
            <h2 className="flex items-center gap-2 text-lg font-semibold text-ink">
              <Shield size={20} weight="fill" className="text-accent" />
              7. Isenção de garantias e limitação de responsabilidade
            </h2>
            <ul className="mt-3 list-disc list-inside space-y-2 text-ink-muted">
              <li>O Serviço é fornecido <strong>sem garantias</strong> de qualquer tipo: expressas, implícitas, comercialização, adequação a fim específico, não violação</li>
              <li>Não garantimos que o Serviço será ininterrupto, livre de erros, seguro ou que defeitos serão corrigidos</li>
              <li>Não nos responsabilizamos por danos indiretos, incidentais, consequentes, perda de dados, lucros cessantes</li>
              <li>Responsabilidade total limitada a R$ 100 (ou valor pago, se houver) nos últimos 12 meses</li>
              <li>Algumas jurisdições não permitem certas limitações; nestes casos, aplicam-se os limites legais mínimos</li>
            </ul>
          </section>

          {/* 8. Indenização */}
          <section>
            <h2 className="flex items-center gap-2 text-lg font-semibold text-ink">
              <Gavel size={20} weight="fill" className="text-accent" />
              8. Indenização
            </h2>
            <p className="mt-3 text-ink-muted">
              Você concorda em indenizar e isentar o juntos, seus mantenedores, colaboradores e provedores de infraestrutura
              de quaisquer reivindicações, danos, custos e honorários advocatícios decorrentes de:
            </p>
            <ul className="mt-3 list-disc list-inside space-y-2 text-ink-muted">
              <li>Seu uso do Serviço em violação destes Termos</li>
              <li>Conteúdo que você enviar (mensagens, uploads, links)</li>
              <li>Violação de direitos de terceiros (copyright, privacidade, etc.)</li>
            </ul>
          </section>

          {/* 9. Modificações do serviço */}
          <section>
            <h2 className="flex items-center gap-2 text-lg font-semibold text-ink">
              <FileText size={20} weight="fill" className="text-accent" />
              9. Modificações, suspensão e encerramento
            </h2>
            <ul className="mt-3 list-disc list-inside space-y-2 text-ink-muted">
              <li>Podemos adicionar, remover ou alterar funcionalidades a qualquer momento</li>
              <li>Podemos suspender temporariamente para manutenção ou emergência</li>
              <li>Podemos encerrar o Serviço permanentemente com aviso razoável (30 dias) na interface</li>
              <li>Seus dados serão excluídos conforme <Link href="/privacy" className="text-accent hover:underline">Política de Privacidade</Link></li>
            </ul>
          </section>

          {/* 10. Lei aplicável e foro */}
          <section>
            <h2 className="flex items-center gap-2 text-lg font-semibold text-ink">
              <Gavel size={20} weight="fill" className="text-accent" />
              10. Lei aplicável e foro
            </h2>
            <p className="mt-3 text-ink-muted">
              Estes Termos são regidos pelas leis da <strong>República Federativa do Brasil</strong>.
              Fica eleito o foro da <strong>Comarca de São Paulo/SP</strong> para dirimir controvérsias,
              com renúncia a qualquer outro, por mais privilegiado que seja.
            </p>
            <p className="mt-2 text-ink-muted">
              Se você está fora do Brasil, também concorda em submeter-se à jurisdição brasileira para disputas relacionadas ao Serviço.
            </p>
          </section>

          {/* 11. Disposições gerais */}
          <section>
            <h2 className="flex items-center gap-2 text-lg font-semibold text-ink">
              <FileText size={20} weight="fill" className="text-accent" />
              11. Disposições gerais
            </h2>
            <ul className="mt-3 list-disc list-inside space-y-2 text-ink-muted">
              <li>Se qualquer cláusula for inválida, as demais permanecem em vigor</li>
              <li>Não exercer um direito não constitui renúncia</li>
              <li>Estes Termos constituem o acordo integral entre você e o juntos</li>
              <li>Podemos ceder nossos direitos/obrigações; você não pode ceder os seus sem consentimento</li>
            </ul>
          </section>

          {/* 12. Contato */}
          <section>
            <h2 className="flex items-center gap-2 text-lg font-semibold text-ink">
              <Envelope size={20} weight="fill" className="text-accent" />
              12. Contato
            </h2>
            <address className="mt-3 not-italic text-ink-muted">
              <p>juntos — Watch Party</p>
            <p>Email: <a href="mailto:legal@juntoswatchparty.vercel.app" className="text-accent hover:underline">legal@juntoswatchparty.vercel.app</a></p>
            <p>Para privacidade/DPO: <a href="mailto:privacy@juntoswatchparty.vercel.app" className="text-accent hover:underline">privacy@juntoswatchparty.vercel.app</a></p>
            <p>Para DMCA/copyright: <a href="mailto:dmca@juntoswatchparty.vercel.app" className="text-accent hover:underline">dmca@juntoswatchparty.vercel.app</a></p>
            </address>
          </section>
        </article>

        <footer className="mt-16 pt-8 border-t border-hairline text-center">
          <Link href="/" className="inline-flex items-center gap-2 text-accent hover:opacity-80">
            <Button variant="ghost" size="sm">← Voltar ao início</Button>
          </Link>
        </footer>
      </main>
    </>
  );
}