import Head from 'next/head';
import { Shield, FileText, Database, Users, WifiHigh, Envelope, Lock } from '@phosphor-icons/react';
import { Button } from '@/components/ui/Button';
import Link from 'next/link';

export default function PrivacyPolicy() {
  const lastUpdated = '27 de setembro de 2026';

  return (
    <>
      <Head>
        <title>Política de Privacidade | juntos</title>
        <meta name="description" content="Política de Privacidade do juntos — plataforma de watchparty com vídeo sincronizado." />
        <meta name="robots" content="index, follow" />
      </Head>

      <main className="mx-auto max-w-4xl px-6 py-12 sm:px-10">
        <header className="mb-12 text-center">
          <h1 className="font-display text-3xl sm:text-4xl font-semibold tracking-tight text-ink">
            Política de Privacidade
          </h1>
          <p className="mt-3 text-sm text-ink-muted">
            Última atualização: <time dateTime="2026-09-27">{lastUpdated}</time>
          </p>
        </header>

        <article className="space-y-10 text-base leading-relaxed text-ink/90">
          {/* 1. Responsável */}
          <section>
            <h2 className="flex items-center gap-2 text-lg font-semibold text-ink">
              <Shield size={20} weight="fill" className="text-accent" />
              1. Responsável pelo tratamento de dados
            </h2>
            <p className="mt-3">
              O <strong>juntos</strong> (&ldquo;nós&rdquo;) é uma plataforma de watchparty que permite assistir a vídeos
              sincronizados com amigos em tempo real. Este documento explica quais dados coletamos, como usamos
              e quais são seus direitos.
            </p>
            <p className="mt-3">
              Para exercer seus direitos ou tirar dúvidas, entre em contato:
              <br />
              <a href="mailto:privacy@juntoswatchparty.vercel.app" className="text-accent hover:underline">
                privacy@juntoswatchparty.vercel.app
              </a>
            </p>
          </section>

          {/* 2. Dados coletados */}
          <section>
            <h2 className="flex items-center gap-2 text-lg font-semibold text-ink">
              <FileText size={20} weight="fill" className="text-accent" />
              2. Dados que coletamos
            </h2>
            <div className="mt-4 space-y-4">
              <div className="flex gap-3 p-4 rounded-xl border border-hairline bg-raised/60">
                <Database size={22} weight="fill" className="mt-1 shrink-0 text-accent" />
                <div>
                  <h3 className="font-medium text-ink">Dados de sessão (obrigatórios)</h3>
                  <ul className="mt-2 list-disc list-inside text-sm text-ink-muted space-y-1">
                    <li>ID de sessão anônimo (cookie <code className="font-mono text-xs bg-hover px-1 rounded">juntos_sid</code>)</li>
                    <li>Nome de exibição escolhido ao entrar na sala</li>
                    <li>Cor do nome e seed do avatar (DiceBear)</li>
                    <li>Foto de perfil opcional (armazenada como data URL no Redis)</li>
                  </ul>
                </div>
              </div>

              <div className="flex gap-3 p-4 rounded-xl border border-hairline bg-raised/60">
                <Users size={22} weight="fill" className="mt-1 shrink-0 text-accent" />
                <div>
                  <h3 className="font-medium text-ink">Dados da sala (temporários)</h3>
                  <ul className="mt-2 list-disc list-inside text-sm text-ink-muted space-y-1">
                    <li>Mensagens de chat (texto, GIFs, imagens comprimidas)</li>
                    <li>Eventos de sincronização (play, pause, seek)</li>
                    <li>Itens da fila (links do YouTube, arquivos enviados e vídeos escolhidos no Google Drive)</li>
                    <li>Reações e sons disparados durante a sessão</li>
                  </ul>
                </div>
              </div>

              <div className="flex gap-3 p-4 rounded-xl border border-hairline bg-raised/60">
                <Lock size={22} weight="fill" className="mt-1 shrink-0 text-accent" />
                <div>
                  <h3 className="font-medium text-ink">Tokens OAuth do YouTube (opcional, por usuário)</h3>
                  <ul className="mt-2 list-disc list-inside text-sm text-ink-muted space-y-1">
                    <li>Access token e refresh token do Google (escopo <code className="font-mono text-xs bg-hover px-1 rounded">youtube.readonly</code>)</li>
                    <li>Armazenados <strong>criptografados (AES-256-GCM)</strong> no Redis</li>
                    <li>Nunca enviados ao navegador; usados apenas no backend para buscas</li>
                    <li>Revogados e excluídos ao clicar em &ldquo;Desconectar&rdquo;</li>
                  </ul>
                </div>
              </div>

              {/*
                O Drive é o caso mais delicado desta política, e por isso tem
                blocos próprios. Três coisas precisam ficar explícitas: o app só
                alcança os arquivos que a pessoa escolheu, o arquivo é lido do
                Google por cada participante — não passa pelo nosso servidor — e
                o Juntos concede compartilhamento no Drive para quem está na
                sala.
              */}
              <div className="flex gap-3 p-4 rounded-xl border border-hairline bg-raised/60">
                <Lock size={22} weight="fill" className="mt-1 shrink-0 text-accent" />
                <div>
                  <h3 className="font-medium text-ink">Google Drive (opcional, por usuário)</h3>
                  <ul className="mt-2 list-disc list-inside text-sm text-ink-muted space-y-1">
                    <li>
                      Access token e refresh token do Google com o escopo restrito
                      {' '}<code className="font-mono text-xs bg-hover px-1 rounded">drive.file</code>, que permite ao
                      juntos acessar <strong>somente os arquivos que você selecionar</strong> no seletor do Google, mais o
                      escopo <code className="font-mono text-xs bg-hover px-1 rounded">userinfo.email</code>, que entrega o
                      seu endereço de e-mail — sem o qual o Google não permite compartilhar um arquivo com outra
                      conta. Não pedimos e não temos acesso ao restante do seu Drive, e não podemos listar seu
                      conteúdo.
                    </li>
                    <li>Armazenados <strong>criptografados (AES-256-GCM)</strong> no Redis, vinculados à sua sessão</li>
                    <li>
                      O refresh token <strong>nunca</strong> sai do servidor. O access token de curta duração é entregue ao
                      seu navegador para abrir o seletor oficial do Google e para reproduzir o vídeo no seu
                      player.
                    </li>
                    <li>
                      Ao escolher um vídeo, guardamos o identificador e o nome do arquivo, além do seu e-mail
                    </li>
                    <li>Revogados no Google e excluídos do nosso lado ao clicar em &ldquo;Trocar de conta&rdquo;</li>
                  </ul>
                </div>
              </div>

              <div className="flex gap-3 p-4 rounded-xl border border-hairline bg-raised/60">
                <WifiHigh size={22} weight="fill" className="mt-1 shrink-0 text-accent" />
                <div>
                  <h3 className="font-medium text-ink">Compartilhamento de arquivos do Drive</h3>
                  <p className="mt-2 text-sm text-ink-muted">
                    Para que todos assistam, o juntos pede ao Google a permissão de leitura do arquivo
                    escolhido <strong>para cada conta conectada que está na sala</strong>, e revoga essa permissão
                    quando a pessoa sai, quando a faixa muda, quando a sessão termina ou quando a sala vence.
                    Quem entra depois recebe o mesmo acesso.
                  </p>
                  <p className="mt-2 text-sm text-ink-muted">
                    <strong>Só removemos o que criamos.</strong> Antes de conceder qualquer coisa, consultamos as
                    permissões que já existem no arquivo; quem já tinha acesso não recebe permissão nova e,
                    portanto, nunca tem o acesso revogado por nós. Um compartilhamento anterior continua intacto.
                  </p>
                  <p className="mt-2 text-sm text-ink-muted">
                    <strong>O vínculo com o app não é reversível por nós.</strong> O Google registra, na sua conta,
                    que o juntos foi autorizado a acessar aquele arquivo. Encerrar a sessão e revogar a permissão
                    no Drive não apaga esse registro: ele só some se você <strong>desautorizar o juntos por
                    completo</strong> no seu Google.
                  </p>
                </div>
              </div>

              <div className="flex gap-3 p-4 rounded-xl border border-hairline bg-raised/60">
                <FileText size={22} weight="fill" className="mt-1 shrink-0 text-accent" />
                <div>
                  <h3 className="font-medium text-ink">Reprodução de vídeo do Drive</h3>
                  <p className="mt-2 text-sm text-ink-muted">
                    O arquivo <strong>não passa pelo nosso servidor nem fica guardado aqui</strong>. Cada
                    participante baixa direto do Google, com o token da própria conta, e o nosso servidor recebe
                    apenas o identificador do arquivo e o estado da sala (play, pause, seek e posição). Pelo mesmo
                    motivo do escopo acima, <strong>quem assiste precisa ter uma conta do Google conectada</strong> e
                    autorizar o app naquele arquivo uma vez.
                  </p>
                </div>
              </div>

              <div className="flex gap-3 p-4 rounded-xl border border-hairline bg-raised/60">
                <WifiHigh size={22} weight="fill" className="mt-1 shrink-0 text-accent" />
                <div>
                  <h3 className="font-medium text-ink">Dados técnicos (logs de servidor)</h3>
                  <ul className="mt-2 list-disc list-inside text-sm text-ink-muted space-y-1">
                    <li>IP anonimizado (últimos octetos zerados)</li>
                    <li>User-Agent, timestamps, erros de API</li>
                    <li><strong>Nunca</strong> tokens, senhas ou conteúdo de mensagens</li>
                  </ul>
                </div>
              </div>
            </div>
          </section>

          {/* 3. Finalidade */}
          <section>
            <h2 className="flex items-center gap-2 text-lg font-semibold text-ink">
              <Shield size={20} weight="fill" className="text-accent" />
              3. Para que usamos seus dados
            </h2>
            <ul className="mt-3 list-disc list-inside space-y-2 text-ink-muted">
              <li><strong>Funcionamento da sala:</strong> sincronizar vídeo, chat, fila, reações em tempo real via Socket.io</li>
              <li><strong>Identidade na sala:</strong> mostrar seu nome, cor, avatar para os demais participantes</li>
              <li><strong>Busca YouTube autenticada:</strong> se você conectar sua conta, usamos <em>seu</em> token para buscar vídeos na API do YouTube em seu nome</li>
              <li>
                <strong>Reprodução a partir do Google Drive:</strong> se você escolher um vídeo do seu Drive, usamos
                o acesso que você concedeu para ler <em>apenas aquele arquivo</em> e, para isso, pedimos ao Google a
                permissão de leitura para as contas que estão na sala. Não usamos o arquivo para nenhum outro fim, e
                não o guardamos nem o transmitimos
              </li>
              <li><strong>Segurança e abuso:</strong> rate limiting, prevenção de spam, proteção contra flood</li>
              <li><strong>Melhoria do serviço:</strong> logs agregados e anonimizados de erros e performance</li>
            </ul>
          </section>

          {/* 4. Compartilhamento */}
          <section>
            <h2 className="flex items-center gap-2 text-lg font-semibold text-ink">
              <Users size={20} weight="fill" className="text-accent" />
              4. Compartilhamento e terceiros
            </h2>
            <ul className="mt-3 list-disc list-inside space-y-2 text-ink-muted">
              <li><strong>Participantes da mesma sala:</strong> veem seu nome, avatar, cor, mensagens e ações (play/pause/seek)</li>
              <li><strong>Google (YouTube API):</strong> apenas se você conectar a conta; enviamos seu access token para <code className="font-mono text-xs bg-hover px-1 rounded">youtube.googleapis.com</code> para buscas e leitura do canal</li>
              <li>
                <strong>Google (Drive API):</strong> apenas se você conectar a conta; enviamos seu access token para
                {' '}<code className="font-mono text-xs bg-hover px-1 rounded">www.googleapis.com</code> para ler o
                arquivo que você selecionou. O Google não nos dá acesso ao restante do seu Drive
              </li>
              <li>
                <strong>Participantes da sala, quanto ao vídeo:</strong> quem estiver na sala recebe os bytes do
                arquivo escolhido, direto do Google. Ao adicioná-lo à fila, você está autorizando os demais a
                assistirem
              </li>
              <li>
                <strong>Google, como compartilhamento:</strong> o Google recebe o nome e o e-mail de cada conta
                conectada na sala, porque é assim que um arquivo é compartilhado. Isso aparece para você no painel de
                compartilhamento do Drive, e some quando a faixa sai da sala
              </li>
              <li><strong>Provedores de infraestrutura:</strong> Redis (Upstash), hospedagem (Vercel/Railway/Render), bucket de uploads (Cloudflare R2 ou AWS S3) — todos com acordos de processamento de dados (DPA). O vídeo do Drive não é gravado em nenhum deles</li>
              <li><strong>Nunca vendemos</strong> dados a anunciantes ou brokers de dados</li>
            </ul>
          </section>

          {/* 5. Retenção */}
          <section>
            <h2 className="flex items-center gap-2 text-lg font-semibold text-ink">
              <Database size={20} weight="fill" className="text-accent" />
              5. Retenção e exclusão
            </h2>
            <ul className="mt-3 list-disc list-inside space-y-2 text-ink-muted">
              <li><strong>Salas ativas:</strong> mantidas enquanto houver participantes; expiram 10 min após última pessoa sair</li>
              <li><strong>Tokens OAuth:</strong> mantidos enquanto a conta estiver conectada; excluídos ao desconectar ou revogar</li>
              <li>
                <strong>Reproduções e compartilhamentos do Drive:</strong> o registro de quem foi adicionada a um
                arquivo do Drive é apagado quando a pessoa sai, quando a faixa muda ou quando a sala vence. O
                <em>vínculo do app com o arquivo</em> na conta de quem autorizou não é nosso para revogar, e dura até a
                pessoa desautorizar o juntos por completo
              </li>
              <li><strong>Sessão (cookie):</strong> 1 ano de inatividade; renova a cada acesso</li>
              <li><strong>Logs de servidor:</strong> 30 dias, depois anonimizados/agregados</li>
              <li>Você pode solicitar exclusão total a qualquer momento via <a href="mailto:privacy@juntoswatchparty.vercel.app" className="text-accent hover:underline">email</a></li>
            </ul>
          </section>

          {/* 6. Direitos (LGPD/GDPR) */}
          <section>
            <h2 className="flex items-center gap-2 text-lg font-semibold text-ink">
              <FileText size={20} weight="fill" className="text-accent" />
              6. Seus direitos (LGPD / GDPR)
            </h2>
            <ul className="mt-3 list-disc list-inside space-y-2 text-ink-muted">
              <li><strong>Acesso:</strong> receber cópia dos dados que mantemos sobre você</li>
              <li><strong>Retificação:</strong> corrigir dados incompletos ou incorretos</li>
              <li><strong>Exclusão:</strong> apagar seus dados (exceto obrigações legais)</li>
              <li><strong>Portabilidade:</strong> receber dados em formato estruturado</li>
              <li><strong>Oposição/Restrição:</strong> limitar processamento não essencial</li>
              <li><strong>Revogação de consentimento:</strong> desconectar o YouTube ou o Google Drive a qualquer momento, direto na interface da fonte de mídia</li>
            </ul>
            <p className="mt-3">
              Para exercer: <a href="mailto:privacy@juntoswatchparty.vercel.app" className="text-accent hover:underline">
                privacy@juntoswatchparty.vercel.app
              </a>
            </p>
          </section>

          {/* 7. Segurança */}
          <section>
            <h2 className="flex items-center gap-2 text-lg font-semibold text-ink">
              <Lock size={20} weight="fill" className="text-accent" />
              7. Segurança
            </h2>
            <ul className="mt-3 list-disc list-inside space-y-2 text-ink-muted">
              <li>HTTPS/TLS 1.2+ em todas as conexões</li>
              <li>Cookies <code className="font-mono text-xs bg-hover px-1 rounded">HttpOnly</code>, <code className="font-mono text-xs bg-hover px-1 rounded">Secure</code>, <code className="font-mono text-xs bg-hover px-1 rounded">SameSite</code></li>
              <li>Tokens OAuth criptografados em repouso (AES-256-GCM)</li>
              <li>Segredos (client_secret, chaves de criptografia) apenas em variáveis de ambiente do servidor</li>
              <li>Rate limiting e validação de entrada em todas as APIs</li>
              <li>
                Escopo do Google limitado a <code className="font-mono text-xs bg-hover px-1 rounded">drive.file</code> e
                ao e-mail: o app não tem permissão para ler, listar ou modificar o restante do seu Drive
              </li>
              <li>
                Ao compartilhar um arquivo do Drive com a sala, o acesso concedido é conferido contra as permissões
                que já existiam, e só é removido o que o próprio juntos criou
              </li>
            </ul>
          </section>

          {/* 8. Crianças */}
          <section>
            <h2 className="flex items-center gap-2 text-lg font-semibold text-ink">
              <Shield size={20} weight="fill" className="text-accent" />
              8. Crianças e adolescentes
            </h2>
            <p className="mt-3 text-ink-muted">
              O juntos não é direcionado a menores de 13 anos. Não coletamos intencionalmente dados de crianças.
              Se você é pai/mãe e acredita que seu filho nos forneceu dados, entre em contato para exclusão.
            </p>
          </section>

          {/* 9. Transferência internacional */}
          <section>
            <h2 className="flex items-center gap-2 text-lg font-semibold text-ink">
              <WifiHigh size={20} weight="fill" className="text-accent" />
              9. Transferência internacional
            </h2>
            <p className="mt-3 text-ink-muted">
              Seus dados podem ser processados em servidores fora do Brasil (EUA, UE) pelos provedores listados na seção 4.
              Esses provedores oferecem garantias adequadas (cláusulas contratuais padrão, decisões de adequação).
            </p>
          </section>

          {/* 10. Alterações */}
          <section>
            <h2 className="flex items-center gap-2 text-lg font-semibold text-ink">
              <FileText size={20} weight="fill" className="text-accent" />
              10. Alterações nesta política
            </h2>
            <p className="mt-3 text-ink-muted">
              Podemos atualizar esta política. A versão mais recente sempre estará em
              <Link href="/privacy" className="text-accent hover:underline">/privacy</Link>.
              Mudanças materiais serão notificadas na interface ou por email (se tivermos seu contato).
            </p>
            <p className="mt-3 text-sm text-ink-faint">
              Em 27 de setembro de 2026, o Drive deixou de ser copiado para o nosso armazenamento e de
              ser transmitido pelo nosso servidor. Cada participante passa a ler o vídeo direto do
              Google, com a própria conta, e o juntos apenas concede e revoga o acesso de quem está na
              sala. Nenhuma outra informação foi alterada.
            </p>
          </section>

          {/* 11. Contato */}
          <section>
            <h2 className="flex items-center gap-2 text-lg font-semibold text-ink">
              <Envelope size={20} weight="fill" className="text-accent" />
              11. Contato / Encarregado de Dados (DPO)
            </h2>
            <address className="mt-3 not-italic text-ink-muted">
              <p>juntos — Watch Party</p>
            <p>Email: <a href="mailto:privacy@juntoswatchparty.vercel.app" className="text-accent hover:underline">privacy@juntoswatchparty.vercel.app</a></p>
            <p>Responsável: Equipe juntos</p>
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