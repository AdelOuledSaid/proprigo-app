/* Proprigo – traduction de l'espace intervenante (portugais, espagnol, arabe).
   Le texte des écrans est traduit à l'affichage, phrase par phrase.
   Jamais traduit : ce que les gens écrivent (messages, consignes, adresses), marqué data-notr. */
(function () {
  'use strict';
  // [français, portugais, espagnol, arabe]
  const T = [
    // navigation et en-tête
    ['Missions', 'Missões', 'Misiones', 'المهام'],
    ['Aide', 'Ajuda', 'Ayuda', 'مساعدة'],
    ['Compte', 'Conta', 'Cuenta', 'الحساب'],
    ['Bonjour', 'Olá', 'Hola', 'مرحبًا'],
    ["missions aujourd'hui", 'missões hoje', 'misiones hoy', 'مهام اليوم'],
    ["mission aujourd'hui", 'missão hoje', 'misión hoy', 'مهمة اليوم'],
    ["Pas de mission aujourd'hui", 'Nenhuma missão hoje', 'Ninguna misión hoy', 'لا توجد مهام اليوم'],
    ['Votre candidature', 'A sua candidatura', 'Su candidatura', 'طلب التوظيف'],
    ['Indépendante', 'Independente', 'Autónoma', 'مستقلة'],
    ['Salariée', 'Assalariada', 'Asalariada', 'موظفة'],
    ['secteur', 'zona', 'zona', 'المنطقة'],
    ['Vous choisissez vos missions et pouvez refuser sans pénalité. Votre tarif :', 'Escolhe as suas missões e pode recusar sem penalização. A sua tarifa:', 'Elige sus misiones y puede rechazar sin penalización. Su tarifa:', 'تختارين مهامك ويمكنك الرفض دون عقوبة. أجرك:'],
    ['Vos missions sont attribuées par le planning Proprigo.', 'As suas missões são atribuídas pelo planeamento da Proprigo.', 'Sus misiones las asigna la planificación de Proprigo.', 'يتم توزيع مهامك من طرف فريق التخطيط في Proprigo.'],
    ['Vos missions sont confiées à d\'autres intervenantes.', 'As suas missões são entregues a outras profissionais.', 'Sus misiones se confían a otras profesionales.', 'تُسند مهامك إلى عاملات أخريات.'],
    ['Absente', 'Ausente', 'Ausente', 'غائبة'],
    // propositions et missions
    ['Propositions', 'Propostas', 'Propuestas', 'العروض'],
    ['Aucune proposition pour le moment.', 'Nenhuma proposta de momento.', 'Ninguna propuesta por ahora.', 'لا توجد عروض حاليًا.'],
    ["L'adresse exacte s'affiche après acceptation.", 'A morada exata aparece depois de aceitar.', 'La dirección exacta aparece tras aceptar.', 'يظهر العنوان الكامل بعد القبول.'],
    ['apporter le kit matériel', 'levar o kit de material', 'llevar el kit de material', 'إحضار عدّة التنظيف'],
    ['Apporter le kit matériel et produits', 'Levar o kit de material e produtos', 'Llevar el kit de material y productos', 'إحضار عدّة التنظيف والمنتجات'],
    ['✖️ Refuser', '✖️ Recusar', '✖️ Rechazar', '✖️ رفض'],
    ['✅ Accepter', '✅ Aceitar', '✅ Aceptar', '✅ قبول'],
    ["Aujourd'hui", 'Hoje', 'Hoy', 'اليوم'],
    ['À venir', 'Próximas', 'Próximas', 'القادمة'],
    ['Client :', 'Cliente:', 'Cliente:', 'الزبون:'],
    ['📝 À savoir (équipe Proprigo)', '📝 A saber (equipa Proprigo)', '📝 A tener en cuenta (equipo Proprigo)', '📝 للعلم (فريق Proprigo)'],
    ['Consignes du logement', 'Instruções da casa', 'Instrucciones de la vivienda', 'تعليمات المنزل'],
    ['À faire', 'A fazer', 'Por hacer', 'المطلوب'],
    ['Prêt à commencer', 'Pronta para começar', 'Lista para empezar', 'جاهزة للبدء'],
    ["C'est parti", 'Vamos lá', 'En marcha', 'لنبدأ'],
    ['Presque fini', 'Quase pronto', 'Casi terminado', 'أوشك على الانتهاء'],
    ['Ça brille !', 'Está a brilhar!', '¡Brilla!', 'يلمع!'],
    ['Photos avant / après', 'Fotos antes / depois', 'Fotos antes / después', 'صور قبل / بعد'],
    ['📷 Photo avant', '📷 Foto antes', '📷 Foto antes', '📷 صورة قبل'],
    ['📷 Photo après', '📷 Foto depois', '📷 Foto después', '📷 صورة بعد'],
    ['Au moins une photo « après » est demandée pour terminer.', 'É pedida pelo menos uma foto «depois» para terminar.', 'Se pide al menos una foto «después» para terminar.', 'يجب التقاط صورة «بعد» واحدة على الأقل للإنهاء.'],
    ['Le client a accepté les photos : vous pourrez les prendre une fois le ménage commencé.', 'O cliente aceitou as fotos: poderá tirá-las depois de começar a limpeza.', 'El cliente aceptó las fotos: podrá tomarlas una vez empezada la limpieza.', 'وافق الزبون على الصور: يمكنك التقاطها بعد بدء التنظيف.'],
    ["Pas de photos pour ce ménage (le client ne l'a pas demandé).", 'Sem fotos para esta limpeza (o cliente não pediu).', 'Sin fotos para esta limpieza (el cliente no las pidió).', 'لا صور لهذا التنظيف (لم يطلبها الزبون).'],
    ['Itinéraire Google Maps', 'Itinerário Google Maps', 'Ruta en Google Maps', 'المسار على خرائط Google'],
    // le jour J
    ['✅ Terminer le ménage', '✅ Terminar a limpeza', '✅ Terminar la limpieza', '✅ إنهاء التنظيف'],
    ['Les boutons « Je pars », « Je suis arrivée » et « Commencer » apparaîtront le jour de la mission.', 'Os botões «Vou a caminho», «Cheguei» e «Começar» aparecem no dia da missão.', 'Los botones «Salgo», «He llegado» y «Empezar» aparecerán el día de la misión.', 'ستظهر أزرار «أنا في الطريق» و«وصلت» و«ابدئي» يوم المهمة.'],
    ['🚶 Je pars', '🚶 Vou a caminho', '🚶 Salgo', '🚶 أنا في الطريق'],
    ['Le client est prévenu de votre arrivée. Déjà sur place ?', 'O cliente é avisado da sua chegada. Já está no local?', 'El cliente recibe aviso de su llegada. ¿Ya está allí?', 'يتم إعلام الزبون بوصولك. هل أنت هناك بالفعل؟'],
    ['Commencer directement le ménage', 'Começar já a limpeza', 'Empezar ya la limpieza', 'ابدئي التنظيف مباشرة'],
    ['▶ Commencer le ménage', '▶ Começar a limpeza', '▶ Empezar la limpieza', '▶ ابدئي التنظيف'],
    ['Commencer le ménage', 'Começar a limpeza', 'Empezar la limpieza', 'ابدئي التنظيف'],
    ['✓ En route', '✓ A caminho', '✓ En camino', '✓ في الطريق'],
    ['arrivée prévue vers', 'chegada prevista por volta das', 'llegada prevista hacia las', 'الوصول المتوقع حوالي'],
    ["changer l'heure", 'mudar a hora', 'cambiar la hora', 'تغيير الوقت'],
    ['📍 Je suis arrivée', '📍 Cheguei', '📍 He llegado', '📍 وصلت'],
    ['✓ Arrivée chez le client', '✓ Chegou a casa do cliente', '✓ Llegada a casa del cliente', '✓ وصلت إلى بيت الزبون'],
    ["J'arrive dans…", 'Chego daqui a…', 'Llego en…', 'أصل بعد…'],
    ['💬 Messages', '💬 Mensagens', '💬 Mensajes', '💬 الرسائل'],
    ['⚠️ Problème', '⚠️ Problema', '⚠️ Problema', '⚠️ مشكلة'],
    ["Je n'arrive pas à entrer", 'Não consigo entrar', 'No consigo entrar', 'لا أستطيع الدخول'],
    ['Un objet est cassé ou abîmé', 'Um objeto está partido ou danificado', 'Un objeto está roto o dañado', 'شيء مكسور أو متضرر'],
    ['Logement bien plus sale que prévu', 'Casa muito mais suja do que o previsto', 'Vivienda mucho más sucia de lo previsto', 'المنزل أوسخ بكثير من المتوقع'],
    ['Je ne me sens pas en sécurité', 'Não me sinto em segurança', 'No me siento segura', 'لا أشعر بالأمان'],
    ['Autre problème', 'Outro problema', 'Otro problema', 'مشكلة أخرى'],
    ["Prévenir l'équipe maintenant", 'Avisar a equipa agora', 'Avisar al equipo ahora', 'أبلغي الفريق الآن'],
    ['Envoyer', 'Enviar', 'Enviar', 'إرسال'],
    ["J'aurai environ 15 min de retard", 'Vou chegar uns 15 min atrasada', 'Llegaré unos 15 min tarde', 'سأتأخر حوالي 15 دقيقة'],
    ["Je n'arrive pas à entrer dans le logement", 'Não consigo entrar na casa', 'No consigo entrar en la vivienda', 'لا أستطيع دخول المنزل'],
    ['Je suis arrivée', 'Cheguei', 'He llegado', 'وصلت'],
    ['Ménage terminé', 'Limpeza terminada', 'Limpieza terminada', 'انتهى التنظيف'],
    ['🗺️ Itinéraire de la journée', '🗺️ Itinerário do dia', '🗺️ Ruta del día', '🗺️ مسار اليوم'],
    ["adresses, dans l'ordre", 'moradas, por ordem', 'direcciones, en orden', 'عناوين، بالترتيب'],
    ['Ménage', 'Limpeza', 'Limpieza', 'تنظيف'],
    ['sur', 'de', 'de', 'من'],
    ['à', 'às', 'a las', 'الساعة'],
    // statuts
    ['Confirmée', 'Confirmada', 'Confirmada', 'مؤكدة'],
    ['En cours', 'Em curso', 'En curso', 'جارية'],
    ['Terminée', 'Terminada', 'Terminada', 'منتهية'],
    ['Annulée', 'Cancelada', 'Cancelada', 'ملغاة'],
    ['Recherche en cours', 'Em procura', 'Buscando', 'جارٍ البحث'],
    ['Grand nettoyage', 'Limpeza profunda', 'Limpieza a fondo', 'تنظيف شامل'],
    ['Nettoyage de bureaux', 'Limpeza de escritórios', 'Limpieza de oficinas', 'تنظيف المكاتب'],
    ['Ménage Airbnb', 'Limpeza Airbnb', 'Limpieza Airbnb', 'تنظيف Airbnb'],
    // semaine, disponibilités, congés
    ['Ma semaine', 'A minha semana', 'Mi semana', 'أسبوعي'],
    ['h de missions', 'h de missões', 'h de misiones', 'ساعات من المهام'],
    ['Congé', 'Folga', 'Libre', 'عطلة'],
    ['Indisponible', 'Indisponível', 'No disponible', 'غير متاحة'],
    ['Dispo', 'Disponível', 'Disponible', 'متاحة'],
    ['à accepter', 'a aceitar', 'por aceptar', 'للقبول'],
    ['Zone claire : vos disponibilités. Les missions et propositions apparaissent dans la journée.', 'Zona clara: as suas disponibilidades. As missões e propostas aparecem no dia.', 'Zona clara: su disponibilidad. Las misiones y propuestas aparecen en el día.', 'المنطقة الفاتحة: أوقات توفرك. تظهر المهام والعروض في اليوم.'],
    ['Mes disponibilités', 'As minhas disponibilidades', 'Mi disponibilidad', 'أوقات توفري'],
    ['jours par semaine · modifier', 'dias por semana · alterar', 'días por semana · cambiar', 'أيام في الأسبوع · تعديل'],
    ['jour par semaine · modifier', 'dia por semana · alterar', 'día por semana · cambiar', 'يوم في الأسبوع · تعديل'],
    ['À remplir', 'Por preencher', 'Por rellenar', 'يجب ملؤها'],
    ['Vous ne recevez des missions que pendant ces horaires.', 'Só recebe missões nestes horários.', 'Solo recibe misiones en este horario.', 'لا تصلك المهام إلا في هذه الأوقات.'],
    ['Lundi', 'Segunda-feira', 'Lunes', 'الإثنين'],
    ['Mardi', 'Terça-feira', 'Martes', 'الثلاثاء'],
    ['Mercredi', 'Quarta-feira', 'Miércoles', 'الأربعاء'],
    ['Jeudi', 'Quinta-feira', 'Jueves', 'الخميس'],
    ['Vendredi', 'Sexta-feira', 'Viernes', 'الجمعة'],
    ['Samedi', 'Sábado', 'Sábado', 'السبت'],
    ['Dimanche', 'Domingo', 'Domingo', 'الأحد'],
    ['Disponible', 'Disponível', 'Disponible', 'متاحة'],
    ['Repos', 'Descanso', 'Descanso', 'راحة'],
    ['Enregistrer mes disponibilités', 'Guardar as minhas disponibilidades', 'Guardar mi disponibilidad', 'حفظ أوقات توفري'],
    ['Mes congés', 'As minhas folgas', 'Mis días libres', 'عطلي'],
    ['Aucun congé prévu.', 'Nenhuma folga prevista.', 'Ningún día libre previsto.', 'لا توجد عطلة مبرمجة.'],
    ['Ajouter le congé', 'Adicionar a folga', 'Añadir el día libre', 'إضافة العطلة'],
    ['Supprimer', 'Apagar', 'Eliminar', 'حذف'],
    // gains et niveau
    ['Mes gains', 'Os meus ganhos', 'Mis ganancias', 'أرباحي'],
    ['Ce mois-ci', 'Este mês', 'Este mes', 'هذا الشهر'],
    ['Mois dernier', 'Mês passado', 'Mes pasado', 'الشهر الماضي'],
    ['ménages terminés', 'limpezas terminadas', 'limpiezas terminadas', 'تنظيفات منتهية'],
    ['ménage terminé', 'limpeza terminada', 'limpieza terminada', 'تنظيف منتهٍ'],
    ['missions prévues', 'missões previstas', 'misiones previstas', 'مهام مبرمجة'],
    ['mission prévue', 'missão prevista', 'misión prevista', 'مهمة مبرمجة'],
    ['Heures de ménage réalisées. Le salaire figure sur votre fiche de paie.', 'Horas de limpeza feitas. O salário aparece no seu recibo de vencimento.', 'Horas de limpieza realizadas. El salario figura en su nómina.', 'ساعات التنظيف المنجزة. يظهر الراتب في كشف الأجر.'],
    ['Calculé avec votre tarif de', 'Calculado com a sua tarifa de', 'Calculado con su tarifa de', 'محسوب بأجرك'],
    ['avant vos cotisations.', 'antes das suas contribuições.', 'antes de sus cotizaciones.', 'قبل الاقتطاعات.'],
    ['Historique mois par mois', 'Histórico mês a mês', 'Historial mes a mes', 'السجل شهرًا بشهر'],
    ['Mois', 'Mês', 'Mes', 'الشهر'],
    ['Ménages', 'Limpezas', 'Limpiezas', 'التنظيفات'],
    ['Heures', 'Horas', 'Horas', 'الساعات'],
    ['Gagné', 'Ganho', 'Ganado', 'المكسوب'],
    ['Versé', 'Pago', 'Pagado', 'المدفوع'],
    ['📄 Relevé', '📄 Extrato', '📄 Extracto', '📄 الكشف'],
    ['de pourboires ce mois-ci', 'de gorjetas este mês', 'de propinas este mes', 'إكراميات هذا الشهر'],
    ['Bonus de niveau', 'Bónus de nível', 'Bonificación de nivel', 'مكافأة المستوى'],
    ['Pas encore', 'Ainda não', 'Todavía no', 'ليس بعد'],
    ['Ajouté à chaque versement.', 'Somado a cada pagamento.', 'Se suma a cada pago.', 'يُضاف إلى كل دفعة.'],
    ['Au niveau Platine.', 'No nível Platina.', 'En el nivel Platino.', 'في المستوى البلاتيني.'],
    ['Semaine du', 'Semana de', 'Semana del', 'أسبوع'],
    ['Mon niveau', 'O meu nível', 'Mi nivel', 'مستواي'],
    ['Bleu', 'Azul', 'Azul', 'أزرق'],
    ['Or', 'Ouro', 'Oro', 'ذهبي'],
    ['Platine', 'Platina', 'Platino', 'بلاتيني'],
    ['Bienvenue chez Proprigo !', 'Bem-vinda à Proprigo!', '¡Bienvenida a Proprigo!', 'مرحبًا بك في Proprigo!'],
    ['Vous êtes prioritaire sur les missions proches.', 'Tem prioridade nas missões próximas.', 'Tiene prioridad en las misiones cercanas.', 'لك الأولوية في المهام القريبة.'],
    ['Prioritaire sur les missions et', 'Prioridade nas missões e', 'Prioridad en las misiones y', 'أولوية في المهام و'],
    ["de l'heure", 'por hora', 'por hora', 'في الساعة'],
    ['Pour passer', 'Para passar a', 'Para pasar a', 'للانتقال إلى'],
    ['priorité sur les missions', 'prioridade nas missões', 'prioridad en las misiones', 'أولوية في المهام'],
    ['🧽 Ménages terminés', '🧽 Limpezas terminadas', '🧽 Limpiezas terminadas', '🧽 التنظيفات المنتهية'],
    ['📅 Aucune absence non prévenue (6 mois)', '📅 Nenhuma falta sem aviso (6 meses)', '📅 Ninguna ausencia sin avisar (6 meses)', '📅 لا غياب دون إشعار (6 أشهر)'],
    ['⭐ Note moyenne', '⭐ Nota média', '⭐ Nota media', '⭐ متوسط التقييم'],
    ['La note compte à partir de', 'A nota conta a partir de', 'La nota cuenta a partir de', 'يُحتسب التقييم ابتداءً من'],
    ['avis (vous en avez', 'avaliações (tem', 'opiniones (tiene', 'تقييمات (لديك'],
    ['Vous avez atteint le plus haut niveau. Merci pour votre travail !', 'Chegou ao nível mais alto. Obrigado pelo seu trabalho!', 'Ha alcanzado el nivel más alto. ¡Gracias por su trabajo!', 'وصلت إلى أعلى مستوى. شكرًا على عملك!'],
    // notifications
    ['Notifications', 'Notificações', 'Notificaciones', 'الإشعارات'],
    ['Recevez les nouvelles missions sur ce téléphone, même application fermée.', 'Receba as novas missões neste telemóvel, mesmo com a aplicação fechada.', 'Reciba las nuevas misiones en este teléfono, incluso con la aplicación cerrada.', 'تصلك المهام الجديدة على هذا الهاتف حتى والتطبيق مغلق.'],
    ['Activer les notifications', 'Ativar as notificações', 'Activar las notificaciones', 'تفعيل الإشعارات'],
    ["✓ C'est activé : vous serez prévenu sur ce téléphone.", '✓ Está ativado: será avisada neste telemóvel.', '✓ Activado: recibirá avisos en este teléfono.', '✓ تم التفعيل: ستصلك الإشعارات على هذا الهاتف.'],
    ['Vérifier que ça marche', 'Verificar se funciona', 'Comprobar que funciona', 'تحقّقي أنه يعمل'],
    ['Ne plus être prévenu', 'Deixar de ser avisada', 'Dejar de recibir avisos', 'إيقاف الإشعارات'],
    // documents
    ['Mes documents', 'Os meus documentos', 'Mis documentos', 'وثائقي'],
    ["Déposez chaque pièce en PDF ou en photo bien nette (5 Mo maximum). Seule l'équipe Proprigo les voit.", 'Envie cada documento em PDF ou numa foto bem nítida (5 MB no máximo). Só a equipa Proprigo os vê.', 'Envíe cada documento en PDF o en una foto bien nítida (5 MB como máximo). Solo el equipo de Proprigo los ve.', 'أرسلي كل وثيقة بصيغة PDF أو صورة واضحة (5 ميغابايت كحد أقصى). لا يراها إلا فريق Proprigo.'],
    ['Toutes les pièces obligatoires sont validées. Merci !', 'Todos os documentos obrigatórios estão validados. Obrigado!', 'Todos los documentos obligatorios están validados. ¡Gracias!', 'تم قبول كل الوثائق الإلزامية. شكرًا!'],
    ['Envoyer la nouvelle version', 'Enviar a nova versão', 'Enviar la nueva versión', 'إرسال النسخة الجديدة'],
    ['Déposer', 'Enviar', 'Subir', 'إرسال'],
    ['Remplacer', 'Substituir', 'Sustituir', 'استبدال'],
    ["Valable jusqu'au", 'Válido até', 'Válido hasta el', 'صالح حتى'],
    ['Expiré depuis le', 'Expirado desde', 'Caducado desde el', 'منتهي الصلاحية منذ'],
    ['plus que', 'faltam só', 'solo quedan', 'لم يبق إلا'],
    ['Voir', 'Ver', 'Ver', 'عرض'],
    ['Pas encore déposé', 'Ainda não enviado', 'Aún no subido', 'لم يُرسل بعد'],
    ['(facultatif)', '(opcional)', '(opcional)', '(اختياري)'],
    ['En cours de vérification', 'Em verificação', 'En verificación', 'قيد التحقق'],
    ['Validé', 'Validado', 'Validado', 'مقبول'],
    ['À renvoyer', 'Por reenviar', 'Por reenviar', 'يجب إعادة الإرسال'],
    ["Pièce d'identité ou titre de séjour en cours de validité", 'Documento de identidade ou autorização de residência válida', 'Documento de identidad o permiso de residencia en vigor', 'بطاقة هوية أو بطاقة إقامة سارية'],
    ['Attestation de sécurité sociale (ou carte Vitale)', 'Certificado da segurança social (ou cartão Vitale)', 'Certificado de la seguridad social (o tarjeta Vitale)', 'شهادة الضمان الاجتماعي (أو بطاقة Vitale)'],
    ['RIB à votre nom', 'NIB/IBAN em seu nome', 'Datos bancarios (RIB) a su nombre', 'كشف الهوية البنكية باسمك (RIB)'],
    ['Avis de situation SIRENE (INSEE) ou extrait Kbis', 'Certificado SIRENE (INSEE) ou extrato Kbis', 'Certificado SIRENE (INSEE) o extracto Kbis', 'شهادة SIRENE (INSEE) أو مستخرج Kbis'],
    ['Attestation de vigilance URSSAF de moins de 6 mois', 'Certificado de vigilância URSSAF com menos de 6 meses', 'Certificado de vigilancia URSSAF de menos de 6 meses', 'شهادة URSSAF عمرها أقل من 6 أشهر'],
    ["Attestation d'assurance responsabilité civile professionnelle", 'Seguro de responsabilidade civil profissional', 'Seguro de responsabilidad civil profesional', 'شهادة تأمين المسؤولية المدنية المهنية'],
    ['Extrait de casier judiciaire (bulletin n° 3)', 'Registo criminal (boletim n.º 3)', 'Certificado de antecedentes penales (boletín n.º 3)', 'صحيفة السوابق العدلية (النشرة رقم 3)'],
    // aide
    ['Les réponses aux questions les plus fréquentes. Pour une mission précise, écrivez dans les 💬 messages de la mission.', 'As respostas às perguntas mais frequentes. Para uma missão concreta, escreva nas 💬 mensagens da missão.', 'Las respuestas a las preguntas más frecuentes. Para una misión concreta, escriba en los 💬 mensajes de la misión.', 'إجابات الأسئلة الأكثر شيوعًا. لمهمة معيّنة، اكتبي في 💬 رسائل المهمة.'],
    ['Comment je reçois mes missions ?', 'Como recebo as minhas missões?', '¿Cómo recibo mis misiones?', 'كيف تصلني المهام؟'],
    ["Indépendante : vous recevez des propositions dans « Missions », avec le prix, la date et le code postal. Vous acceptez celles qui vous conviennent ; refuser n'entraîne aucune pénalité. L'adresse exacte s'affiche après acceptation. Salariée : le planning Proprigo vous attribue les missions selon vos disponibilités.", 'Independente: recebe propostas em «Missões», com o preço, a data e o código postal. Aceita as que lhe convêm; recusar não tem penalização. A morada exata aparece depois de aceitar. Assalariada: o planeamento Proprigo atribui-lhe as missões segundo as suas disponibilidades.', 'Autónoma: recibe propuestas en «Misiones», con el precio, la fecha y el código postal. Acepta las que le convienen; rechazar no tiene penalización. La dirección exacta aparece tras aceptar. Asalariada: la planificación de Proprigo le asigna las misiones según su disponibilidad.', 'المستقلة: تصلك العروض في «المهام» مع السعر والتاريخ والرمز البريدي. تقبلين ما يناسبك، والرفض بلا عقوبة. يظهر العنوان الكامل بعد القبول. الموظفة: يوزع فريق التخطيط المهام حسب أوقات توفرك.'],
    ['Comment être prévenue des nouvelles missions ?', 'Como ser avisada das novas missões?', '¿Cómo recibir aviso de las nuevas misiones?', 'كيف تصلني إشعارات المهام الجديدة؟'],
    ["Activez les notifications dans « Missions », rubrique « Notifications ». Vous êtes prévenue sur votre téléphone, même l'application fermée.", 'Ative as notificações em «Missões», secção «Notificações». É avisada no telemóvel, mesmo com a aplicação fechada.', 'Active las notificaciones en «Misiones», apartado «Notificaciones». Recibirá avisos en el teléfono, incluso con la aplicación cerrada.', 'فعّلي الإشعارات في «المهام»، قسم «الإشعارات». تصلك على الهاتف حتى والتطبيق مغلق.'],
    ['Comment indiquer mes horaires et mes congés ?', 'Como indicar os meus horários e folgas?', '¿Cómo indico mi horario y mis días libres?', 'كيف أحدد أوقاتي وعطلي؟'],
    ["Dans « Missions » : « Mes disponibilités » pour vos jours et horaires de travail, « Mes congés » pour vos absences. Vous ne recevez aucune mission en dehors de ces horaires ni pendant vos congés.", 'Em «Missões»: «As minhas disponibilidades» para os dias e horários de trabalho, «As minhas folgas» para as ausências. Não recebe missões fora destes horários nem durante as folgas.', 'En «Misiones»: «Mi disponibilidad» para sus días y horarios, «Mis días libres» para sus ausencias. No recibe misiones fuera de ese horario ni en sus días libres.', 'في «المهام»: «أوقات توفري» لأيام وساعات العمل، و«عطلي» لأيام الغياب. لا تصلك مهام خارج هذه الأوقات ولا أثناء العطل.'],
    ['Le jour de la mission, que dois-je faire ?', 'No dia da missão, o que devo fazer?', 'El día de la misión, ¿qué debo hacer?', 'ماذا أفعل يوم المهمة؟'],
    ["Appuyez sur 🚶 « Je pars » en partant et indiquez dans combien de temps vous arrivez : le client est prévenu. Puis 📍 « Je suis arrivée », ▶ « Commencer le ménage », et ✅ « Terminer le ménage » à la fin. Cochez les tâches au fur et à mesure.", 'Carregue em 🚶 «Vou a caminho» ao sair e indique daqui a quanto tempo chega: o cliente é avisado. Depois 📍 «Cheguei», ▶ «Começar a limpeza» e ✅ «Terminar a limpeza» no fim. Marque as tarefas à medida que as faz.', 'Pulse 🚶 «Salgo» al salir e indique en cuánto tiempo llega: el cliente recibe aviso. Luego 📍 «He llegado», ▶ «Empezar la limpieza» y ✅ «Terminar la limpieza» al final. Marque las tareas a medida que las hace.', 'اضغطي 🚶 «أنا في الطريق» عند الخروج وحددي بعد كم من الوقت تصلين: يتم إعلام الزبون. ثم 📍 «وصلت» و▶ «ابدئي التنظيف» و✅ «إنهاء التنظيف» في النهاية. أشّري على المهام أولًا بأول.'],
    ['Je vais être en retard, que faire ?', 'Vou chegar atrasada, o que faço?', 'Voy a llegar tarde, ¿qué hago?', 'سأتأخر، ماذا أفعل؟'],
    ["Ouvrez 💬 « Messages » sur la mission et envoyez « J'aurai environ 15 min de retard ». Vous pouvez aussi changer l'heure d'arrivée prévue après « Je pars ».", 'Abra 💬 «Mensagens» na missão e envie «Vou chegar uns 15 min atrasada». Também pode mudar a hora de chegada prevista depois de «Vou a caminho».', 'Abra 💬 «Mensajes» en la misión y envíe «Llegaré unos 15 min tarde». También puede cambiar la hora de llegada prevista tras «Salgo».', 'افتحي 💬 «الرسائل» في المهمة وأرسلي «سأتأخر حوالي 15 دقيقة». يمكنك أيضًا تغيير وقت الوصول بعد «أنا في الطريق».'],
    ['Il y a un problème chez le client', 'Há um problema em casa do cliente', 'Hay un problema en casa del cliente', 'هناك مشكلة عند الزبون'],
    ["Appuyez sur ⚠️ « Problème » sur la mission : accès impossible, objet cassé, logement bien plus sale que prévu, ou si vous ne vous sentez pas en sécurité. L'équipe est prévenue tout de suite. En cas de danger, appelez le 17.", 'Carregue em ⚠️ «Problema» na missão: acesso impossível, objeto partido, casa muito mais suja do que o previsto, ou se não se sentir segura. A equipa é avisada de imediato. Em caso de perigo, ligue 17.', 'Pulse ⚠️ «Problema» en la misión: acceso imposible, objeto roto, vivienda mucho más sucia de lo previsto, o si no se siente segura. El equipo recibe aviso al momento. En caso de peligro, llame al 17.', 'اضغطي ⚠️ «مشكلة» في المهمة: تعذّر الدخول، شيء مكسور، منزل أوسخ بكثير من المتوقع، أو إن لم تشعري بالأمان. يُبلَّغ الفريق فورًا. في حالة الخطر، اتصلي بالرقم 17.'],
    ['Les photos sont-elles obligatoires ?', 'As fotos são obrigatórias?', '¿Las fotos son obligatorias?', 'هل الصور إلزامية؟'],
    ["Seulement si le client les a acceptées. Dans ce cas, prenez au moins une 📷 « Photo après » avant de terminer. Sinon, aucune photo n'est demandée.", 'Só se o cliente as aceitou. Nesse caso, tire pelo menos uma 📷 «Foto depois» antes de terminar. Caso contrário, não são pedidas fotos.', 'Solo si el cliente las aceptó. En ese caso, tome al menos una 📷 «Foto después» antes de terminar. Si no, no se pide ninguna foto.', 'فقط إذا وافق الزبون عليها. في هذه الحالة التقطي على الأقل 📷 «صورة بعد» قبل الإنهاء. وإلا فلا صور مطلوبة.'],
    ['Quand suis-je payée ?', 'Quando sou paga?', '¿Cuándo me pagan?', 'متى أتقاضى أجري؟'],
    ['Indépendante : par virement chaque semaine pour les ménages terminés. Salariée : votre salaire figure sur votre fiche de paie. Dans les deux cas, « Mes gains » montre vos heures mois par mois.', 'Independente: por transferência todas as semanas pelas limpezas terminadas. Assalariada: o salário aparece no recibo de vencimento. Nos dois casos, «Os meus ganhos» mostra as horas mês a mês.', 'Autónoma: por transferencia cada semana por las limpiezas terminadas. Asalariada: su salario figura en la nómina. En ambos casos, «Mis ganancias» muestra sus horas mes a mes.', 'المستقلة: بتحويل بنكي كل أسبوع عن التنظيفات المنتهية. الموظفة: يظهر الراتب في كشف الأجر. في الحالتين، يعرض «أرباحي» ساعاتك شهرًا بشهر.'],
    ['Je ne peux pas venir à une mission', 'Não posso ir a uma missão', 'No puedo ir a una misión', 'لا أستطيع الحضور إلى مهمة'],
    ["Prévenez l'équipe le plus tôt possible par e-mail à contact@proprigo.fr, en donnant la date et l'adresse de la mission. Une remplaçante sera cherchée pour le client. Pour une absence prévue, ajoutez-la dans « Mes congés ».", 'Avise a equipa o mais cedo possível por e-mail para contact@proprigo.fr, com a data e a morada da missão. Será procurada uma substituta para o cliente. Para uma ausência prevista, adicione-a em «As minhas folgas».', 'Avise al equipo lo antes posible por correo a contact@proprigo.fr, con la fecha y la dirección de la misión. Se buscará una sustituta para el cliente. Para una ausencia prevista, añádala en «Mis días libres».', 'أبلغي الفريق في أقرب وقت عبر البريد contact@proprigo.fr مع تاريخ وعنوان المهمة. سنبحث عن بديلة للزبون. للغياب المبرمج، أضيفيه في «عطلي».'],
    ['Où envoyer mes documents ?', 'Onde envio os meus documentos?', '¿Dónde envío mis documentos?', 'أين أرسل وثائقي؟'],
    ['Dans « Missions », rubrique « Mes documents ». Vous pouvez envoyer une photo ou un PDF depuis votre téléphone.', 'Em «Missões», secção «Os meus documentos». Pode enviar uma foto ou um PDF a partir do telemóvel.', 'En «Misiones», apartado «Mis documentos». Puede enviar una foto o un PDF desde su teléfono.', 'في «المهام»، قسم «وثائقي». يمكنك إرسال صورة أو ملف PDF من هاتفك.'],
    ["Contacter l'équipe", 'Contactar a equipa', 'Contactar al equipo', 'التواصل مع الفريق'],
    ["Par la messagerie d'une mission, ou par e-mail :", 'Pelas mensagens de uma missão, ou por e-mail:', 'Por los mensajes de una misión, o por correo:', 'عبر رسائل المهمة، أو عبر البريد:'],
    // compte
    ['🌐 Langue', '🌐 Língua', '🌐 Idioma', '🌐 اللغة'],
    ['Ma présentation aux clients', 'A minha apresentação aos clientes', 'Mi presentación a los clientes', 'تقديمي للزبائن'],
    ['📷 Ma photo', '📷 A minha foto', '📷 Mi foto', '📷 صورتي'],
    ['Ajouter ma photo', 'Adicionar a minha foto', 'Añadir mi foto', 'إضافة صورتي'],
    ['Changer la photo', 'Mudar a foto', 'Cambiar la foto', 'تغيير الصورة'],
    ['Visible des clients', 'Visível para os clientes', 'Visible para los clientes', 'ظاهرة للزبائن'],
    ['🏦 Mon compte bancaire', '🏦 A minha conta bancária', '🏦 Mi cuenta bancaria', '🏦 حسابي البنكي'],
    ['Pour recevoir vos versements.', 'Para receber os seus pagamentos.', 'Para recibir sus pagos.', 'لاستلام دفعاتك.'],
    ['Compte enregistré :', 'Conta registada:', 'Cuenta registrada:', 'الحساب المسجل:'],
    ['Aucun compte enregistré.', 'Nenhuma conta registada.', 'Ninguna cuenta registrada.', 'لا يوجد حساب مسجل.'],
    ["L'équipe est prévenue à chaque changement.", 'A equipa é avisada a cada alteração.', 'El equipo recibe aviso de cada cambio.', 'يُبلَّغ الفريق عند كل تغيير.'],
    ['Titulaire du compte', 'Titular da conta', 'Titular de la cuenta', 'صاحب الحساب'],
    ['Changer de compte', 'Mudar de conta', 'Cambiar de cuenta', 'تغيير الحساب'],
    ['Enregistrer mon IBAN', 'Guardar o meu IBAN', 'Guardar mi IBAN', 'حفظ رقم IBAN'],
    ['Se déconnecter', 'Terminar sessão', 'Cerrar sesión', 'تسجيل الخروج'],
  ];
  const IDX = { pt: 1, es: 2, ar: 3 };
  const LOCALE = { fr: 'fr-FR', pt: 'pt-PT', es: 'es-ES', ar: 'ar' };
  let current = 'fr';
  let pairs = [];
  const escRe = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  function build(lang) {
    const i = IDX[lang];
    pairs = i ? T.filter((r) => r[i]).sort((a, b) => b[0].length - a[0].length)
      .map((r) => [new RegExp(`(^|[^\\p{L}\\p{N}])${escRe(r[0])}(?![\\p{L}\\p{N}])`, 'gu'), r[i]]) : [];
  }
  const SKIP = 'script,style,textarea,input,select option[value=""],[data-notr],.bubble,.instructions';
  function translateText(s) {
    let out = s;
    for (const [re, to] of pairs) out = out.replace(re, (m, pre) => pre + to);
    return out;
  }
  function translate(root) {
    if (!pairs.length || !root) return;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => (!n.nodeValue.trim() || (n.parentElement && n.parentElement.closest(SKIP)) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
    });
    const nodes = []; while (walker.nextNode()) nodes.push(walker.currentNode);
    for (const n of nodes) { const v = translateText(n.nodeValue); if (v !== n.nodeValue) n.nodeValue = v; }
  }
  let observer = null;
  function set(lang) {
    current = IDX[lang] ? lang : 'fr';
    build(current);
    document.documentElement.lang = current === 'fr' ? 'fr' : current;
    document.documentElement.dir = current === 'ar' ? 'rtl' : 'ltr';
    if (observer) { observer.disconnect(); observer = null; }
    if (current === 'fr') return;
    translate(document.body);
    let queued = false;
    observer = new MutationObserver(() => { if (queued) return; queued = true; requestAnimationFrame(() => { queued = false; translate(document.body); }); });
    observer.observe(document.body, { childList: true, subtree: true });
  }
  window.PROPRIGO_I18N = { set, translate, get lang() { return current; }, locale: () => LOCALE[current], LANGS: [['fr', 'Français'], ['pt', 'Português'], ['es', 'Español'], ['ar', 'العربية']] };
}());
