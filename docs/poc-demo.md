# Roteiro da POC (20 minutos)

Antes: Docker aberto, `docker compose up -d` em `deploy/compose`, ColetaDoc no ar (veja `coletadoc-demo.md`) e, se for mostrar IA, o modelo carregado. Abra `http://localhost:3010`.

## 0. Prontidão (1 min)
**Visão geral → "Pontos de atenção"**. Se aparecer "preparar", é o que falta (runner, IA, armazenamento, usuários, mapa, spec, regressão). Resolva antes de apresentar.

## 1. Mapear com dois usuários (3 min)
1. **Configurações → Credenciais**: cadastre pelo menos dois usuários (por exemplo `admin` e `operador`). Cada um é explorado e testado à parte.
2. **Nova exploração** → tamanho **Padrão** (ou **App grande** para mostrar o limite de 1.000 telas e 2 h).
3. Enquanto roda, o **Mapa** se desenha ao vivo. Ao terminar, a spec **"Varredura automática · ambiente"** já existe.
4. Dá para **explorar só um usuário** (caixas "Explorar como"): o mapa dos outros continua como estava. E uma exploração que parou (cancelada, falhou, limite de telas ou de tempo) **continua de onde parou** ("Continuar de onde parou" no diálogo, ou o botão em Execuções): o que já foi examinado não é refeito.

## 2. Mapa e quem enxerga o quê (3 min)
- **Mapa → Acesso por usuário**: as telas que só alguns usuários alcançam vêm primeiro (fluxos alternativos).
- **Ver como**: filtra o grafo por usuário. Cores: verde passou, vermelho falhou, roxo pulado, azul coberto e não testado, laranja pendência, cinza sem spec.

## 3. Especificações (3 min)
- **Especificações → Nova especificação**: cole o texto de requisitos. A IA extrai (specs longas são lidas em partes). Requisitos vagos, curtos, compostos ou repetidos ganham **"revisar"**.
- **Cruzar com a spec**: liga requisitos a telas; o que não liga vira pendência.
- Em cada spec: **Rodar esta spec**, **Renomear**, **Excluir**, editar requisitos.

## 4. Testar (3 min)
- **Nova regressão**: escolha **quais usuários** testar e quantos navegadores em paralelo.
- Para **inserir dados de verdade**, use um ambiente de homologação com política **Permitir**. Com **Bloquear** (padrão), nada é gravado e o formulário de escrita fica "pulado".
- **Execuções → Checagens e evidências**: valores digitados, requisições, HTTP e imagem; filtro por usuário e "só falhas".
- **Bugs**: um por defeito, com os usuários afetados.

## 5. Fluxos (3 min)
- **Fluxos**: uma raia por usuário, com a imagem de cada tela. A tela que um usuário não alcança aparece como "sem acesso".
- Origens: **Jornadas** (o que o agente achou), **Requisitos** e **Execução** (com o resultado daquela regressão).
- Cada tela diz por qual requisito é coberta, ou **"sem requisito"**: é onde fluxo e especificação não batem.

## 6. Relatório (3 min)
- **Relatório** (botão no topo, em qualquer página): pontos de atenção, prontidão e o texto padrão.
- **Resumir com IA**: reescreve no mesmo formato, usando só os números do relatório. Se a IA errar o formato, o texto padrão continua.
- **Baixar HTML** (abre e imprime/salva em PDF), **Markdown** ou **JSON**.

## 7. Segurança, junto com o resto (3 min)
- Toda exploração e regressão **já verifica segurança** (caixa "Verificar segurança" no diálogo; dá para desligar). Não é um módulo à parte: os achados aparecem onde o resto aparece.
- **Execuções → Segurança**: quantas verificações rodaram, quantas falharam e a gravidade; "Ver as verificações" lista cada uma com a evidência (o que foi testado, onde, o detalhe).
- **Bugs → Segurança**: um bug por achado (a mesma falha no admin e no operador é um bug só), com a gravidade da verificação. Ele só é dado como corrigido quando a **própria verificação** passa de novo.
- O que procura: cabeçalhos de proteção, cookies de sessão (HttpOnly, SameSite, Secure), formulários sem token anti-CSRF, **XSS refletido** e **SQL injection** (erro de banco) em parâmetros de endereço e buscas, redirecionamento aberto, arquivos expostos (`.git`, `.env`), CORS e mensagens de erro que vazam detalhes.
- **Só lê**: as injeções vão por GET, nada é enviado por POST nem com a política Permitir. Para mostrar ao vivo: `PORT=3099 node fixtures/sample-app/server.mjs`, ambiente com base `http://host.docker.internal:3099/sec` e a credencial `sec` / `sec123` (planta XSS, SQL injection, redirecionamento aberto, cookie sem HttpOnly, formulário sem token e `.env` exposto).
- **Relatório** tem a seção "Segurança" e a Visão geral um cartão com as falhas abertas.

## 8. Quando a aplicação cai ou o login não funciona (1 min)
- Um **aviso só**, no topo de qualquer página: "A aplicação está fora do ar" ou "O login não funcionou", com o motivo (por exemplo, o que a tela de login disse, ou que o login pede captcha/2FA ou passa por um SSO fora dos hosts permitidos) e o atalho para corrigir. Nada vira bug por isso, e o mapa que já existia não é apagado.
- A run aparece como **Bloqueada** (não "Falhou") e some o aviso quando a próxima funciona. Também é o primeiro ponto de atenção do relatório.
- O login agora acha a tela sozinho: link "Entrar" na página inicial, tela desenhada por script, primeiro passo só com o e-mail, botão que não responde a Enter. **Captcha, código 2FA e login único (SSO) o agente não faz**: diz isso em vez de mapear só a área pública.

## O que dizer sobre limites (sem rodeio)
- O agente nunca sai da sessão nem remove a conta; produção não executa.
- Cada visita a uma página custa cerca de 0,35 s por causa da espera de estabilização.
- As imagens das telas podem mostrar dado de cliente (os campos de entrada são cobertos): falta definir a política de retenção.
- As verificações de segurança são as **clássicas**, só de leitura: não fazem XSS armazenado nem SQL injection por formulário (precisariam enviar dados), nem controle de acesso, upload ou SSRF. Não substituem um pentest.
- Continuar uma exploração revisita as páginas (leitura, rápido) para achar o que faltou; o que só era alcançado por uma ação de uma tela ainda não examinada quando parou precisa de nova exploração.
- Modelo local pequeno é lento e erra mais; para a POC valer a pena, use Azure OpenAI.
