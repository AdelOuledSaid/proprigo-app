/* Proprigo – traduction de l'espace intervenante (anglais, portugais, espagnol, arabe).
   Le texte des écrans est traduit à l'affichage, phrase par phrase.
   Jamais traduit : ce que les gens écrivent (messages, consignes, adresses), marqué data-notr. */
(function () {
  'use strict';
  // [français, portugais, espagnol, arabe, anglais]
  const T = [
    // navigation et en-tête
    ['Missions', 'Missões', 'Misiones', 'المهام', "Missions"],
    ['Aide', 'Ajuda', 'Ayuda', 'مساعدة', "Help"],
    ['Compte', 'Conta', 'Cuenta', 'الحساب', "Account"],
    ['Bonjour', 'Olá', 'Hola', 'مرحبًا', "Hello"],
    ["missions aujourd'hui", 'missões hoje', 'misiones hoy', 'مهام اليوم', "missions today"],
    ["mission aujourd'hui", 'missão hoje', 'misión hoy', 'مهمة اليوم', "mission today"],
    ["Pas de mission aujourd'hui", 'Nenhuma missão hoje', 'Ninguna misión hoy', 'لا توجد مهام اليوم', "No mission today"],
    ['Votre candidature', 'A sua candidatura', 'Su candidatura', 'طلب التوظيف', "Your application"],
    ['Indépendante', 'Independente', 'Autónoma', 'مستقلة', "Self-employed"],
    ['Salariée', 'Assalariada', 'Asalariada', 'موظفة', "Employee"],
    ['secteur', 'zona', 'zona', 'المنطقة', "area"],
    ['Vous choisissez vos missions et pouvez refuser sans pénalité. Votre tarif :', 'Escolhe as suas missões e pode recusar sem penalização. A sua tarifa:', 'Elige sus misiones y puede rechazar sin penalización. Su tarifa:', 'تختارين مهامك ويمكنك الرفض دون عقوبة. أجرك:', "You choose your missions and can decline with no penalty. Your rate:"],
    ['Vos missions sont attribuées par le planning Proprigo.', 'As suas missões são atribuídas pelo planeamento da Proprigo.', 'Sus misiones las asigna la planificación de Proprigo.', 'يتم توزيع مهامك من طرف فريق التخطيط في Proprigo.', "Your missions are assigned by the Proprigo schedule."],
    ['Vos missions sont confiées à d\'autres intervenantes.', 'As suas missões são entregues a outras profissionais.', 'Sus misiones se confían a otras profesionales.', 'تُسند مهامك إلى عاملات أخريات.', "Your missions are given to other cleaners."],
    ['Absente', 'Ausente', 'Ausente', 'غائبة', "Away"],
    // propositions et missions
    ['Propositions', 'Propostas', 'Propuestas', 'العروض', "Offers"],
    ['Aucune proposition pour le moment.', 'Nenhuma proposta de momento.', 'Ninguna propuesta por ahora.', 'لا توجد عروض حاليًا.', "No offers for now."],
    ["L'adresse exacte s'affiche après acceptation.", 'A morada exata aparece depois de aceitar.', 'La dirección exacta aparece tras aceptar.', 'يظهر العنوان الكامل بعد القبول.', "The exact address appears after you accept."],
    ['apporter le kit matériel', 'levar o kit de material', 'llevar el kit de material', 'إحضار عدّة التنظيف', "bring the cleaning kit"],
    ['Apporter le kit matériel et produits', 'Levar o kit de material e produtos', 'Llevar el kit de material y productos', 'إحضار عدّة التنظيف والمنتجات', "Bring the cleaning kit and products"],
    ['✖️ Refuser', '✖️ Recusar', '✖️ Rechazar', '✖️ رفض', "✖️ Decline"],
    ['✅ Accepter', '✅ Aceitar', '✅ Aceptar', '✅ قبول', "✅ Accept"],
    ["Aujourd'hui", 'Hoje', 'Hoy', 'اليوم', "Today"],
    ['À venir', 'Próximas', 'Próximas', 'القادمة', "Upcoming"],
    ['Client :', 'Cliente:', 'Cliente:', 'الزبون:', "Client:"],
    ['📝 À savoir (équipe Proprigo)', '📝 A saber (equipa Proprigo)', '📝 A tener en cuenta (equipo Proprigo)', '📝 للعلم (فريق Proprigo)', "📝 Good to know (Proprigo team)"],
    ['Consignes du logement', 'Instruções da casa', 'Instrucciones de la vivienda', 'تعليمات المنزل', "Home instructions"],
    ['À faire', 'A fazer', 'Por hacer', 'المطلوب', "To do"],
    ['Prêt à commencer', 'Pronta para começar', 'Lista para empezar', 'جاهزة للبدء', "Ready to start"],
    ["C'est parti", 'Vamos lá', 'En marcha', 'لنبدأ', "Under way"],
    ['Presque fini', 'Quase pronto', 'Casi terminado', 'أوشك على الانتهاء', "Almost done"],
    ['Ça brille !', 'Está a brilhar!', '¡Brilla!', 'يلمع!', "Sparkling!"],
    ['Photos avant / après', 'Fotos antes / depois', 'Fotos antes / después', 'صور قبل / بعد', "Before / after photos"],
    ['📷 Photo avant', '📷 Foto antes', '📷 Foto antes', '📷 صورة قبل', "📷 Before photo"],
    ['📷 Photo après', '📷 Foto depois', '📷 Foto después', '📷 صورة بعد', "📷 After photo"],
    ['Au moins une photo « après » est demandée pour terminer.', 'É pedida pelo menos uma foto «depois» para terminar.', 'Se pide al menos una foto «después» para terminar.', 'يجب التقاط صورة «بعد» واحدة على الأقل للإنهاء.', "At least one “after” photo is needed to finish."],
    ['Le client a accepté les photos : vous pourrez les prendre une fois le ménage commencé.', 'O cliente aceitou as fotos: poderá tirá-las depois de começar a limpeza.', 'El cliente aceptó las fotos: podrá tomarlas una vez empezada la limpieza.', 'وافق الزبون على الصور: يمكنك التقاطها بعد بدء التنظيف.', "The client accepted photos: you can take them once the cleaning has started."],
    ["Pas de photos pour ce ménage (le client ne l'a pas demandé).", 'Sem fotos para esta limpeza (o cliente não pediu).', 'Sin fotos para esta limpieza (el cliente no las pidió).', 'لا صور لهذا التنظيف (لم يطلبها الزبون).', "No photos for this cleaning (the client did not ask for them)."],
    ['Itinéraire Google Maps', 'Itinerário Google Maps', 'Ruta en Google Maps', 'المسار على خرائط Google', "Google Maps directions"],
    // le jour J
    ['✅ Terminer le ménage', '✅ Terminar a limpeza', '✅ Terminar la limpieza', '✅ إنهاء التنظيف', "✅ Finish the cleaning"],
    ['Les boutons « Je pars », « Je suis arrivée » et « Commencer » apparaîtront le jour de la mission.', 'Os botões «Vou a caminho», «Cheguei» e «Começar» aparecem no dia da missão.', 'Los botones «Salgo», «He llegado» y «Empezar» aparecerán el día de la misión.', 'ستظهر أزرار «أنا في الطريق» و«وصلت» و«ابدئي» يوم المهمة.', "The “I'm leaving”, “I've arrived” and “Start” buttons will appear on the day of the mission."],
    ['🚶 Je pars', '🚶 Vou a caminho', '🚶 Salgo', '🚶 أنا في الطريق', "🚶 I'm leaving"],
    ['Le client est prévenu de votre arrivée. Déjà sur place ?', 'O cliente é avisado da sua chegada. Já está no local?', 'El cliente recibe aviso de su llegada. ¿Ya está allí?', 'يتم إعلام الزبون بوصولك. هل أنت هناك بالفعل؟', "The client is told you are coming. Already there?"],
    ['Commencer directement le ménage', 'Começar já a limpeza', 'Empezar ya la limpieza', 'ابدئي التنظيف مباشرة', "Start the cleaning now"],
    ['▶ Commencer le ménage', '▶ Começar a limpeza', '▶ Empezar la limpieza', '▶ ابدئي التنظيف', "▶ Start the cleaning"],
    ['Commencer le ménage', 'Começar a limpeza', 'Empezar la limpieza', 'ابدئي التنظيف', "Start the cleaning"],
    ['✓ En route', '✓ A caminho', '✓ En camino', '✓ في الطريق', "✓ On the way"],
    ['arrivée prévue vers', 'chegada prevista por volta das', 'llegada prevista hacia las', 'الوصول المتوقع حوالي', "expected arrival around"],
    ["changer l'heure", 'mudar a hora', 'cambiar la hora', 'تغيير الوقت', "change the time"],
    ['📍 Je suis arrivée', '📍 Cheguei', '📍 He llegado', '📍 وصلت', "📍 I've arrived"],
    ['✓ Arrivée chez le client', '✓ Chegou a casa do cliente', '✓ Llegada a casa del cliente', '✓ وصلت إلى بيت الزبون', "✓ Arrived at the client's"],
    ["J'arrive dans…", 'Chego daqui a…', 'Llego en…', 'أصل بعد…', "I'll be there in…"],
    ['💬 Messages', '💬 Mensagens', '💬 Mensajes', '💬 الرسائل', "💬 Messages"],
    ['⚠️ Problème', '⚠️ Problema', '⚠️ Problema', '⚠️ مشكلة', "⚠️ Problem"],
    ["Je n'arrive pas à entrer", 'Não consigo entrar', 'No consigo entrar', 'لا أستطيع الدخول', "I can't get in"],
    ['Un objet est cassé ou abîmé', 'Um objeto está partido ou danificado', 'Un objeto está roto o dañado', 'شيء مكسور أو متضرر', "Something is broken or damaged"],
    ['Logement bien plus sale que prévu', 'Casa muito mais suja do que o previsto', 'Vivienda mucho más sucia de lo previsto', 'المنزل أوسخ بكثير من المتوقع', "Home much dirtier than expected"],
    ['Je ne me sens pas en sécurité', 'Não me sinto em segurança', 'No me siento segura', 'لا أشعر بالأمان', "I don't feel safe"],
    ['Autre problème', 'Outro problema', 'Otro problema', 'مشكلة أخرى', "Other problem"],
    ["Prévenir l'équipe maintenant", 'Avisar a equipa agora', 'Avisar al equipo ahora', 'أبلغي الفريق الآن', "Tell the team now"],
    ['Envoyer', 'Enviar', 'Enviar', 'إرسال', "Send"],
    ["J'aurai environ 15 min de retard", 'Vou chegar uns 15 min atrasada', 'Llegaré unos 15 min tarde', 'سأتأخر حوالي 15 دقيقة', "I'll be about 15 min late"],
    ["Je n'arrive pas à entrer dans le logement", 'Não consigo entrar na casa', 'No consigo entrar en la vivienda', 'لا أستطيع دخول المنزل', "I can't get into the home"],
    ['Je suis arrivée', 'Cheguei', 'He llegado', 'وصلت', "I've arrived"],
    ['Ménage terminé', 'Limpeza terminada', 'Limpieza terminada', 'انتهى التنظيف', "Cleaning finished"],
    ['🗺️ Itinéraire de la journée', '🗺️ Itinerário do dia', '🗺️ Ruta del día', '🗺️ مسار اليوم', "🗺️ Today's route"],
    ["adresses, dans l'ordre", 'moradas, por ordem', 'direcciones, en orden', 'عناوين، بالترتيب', "addresses, in order"],
    ['Ménage', 'Limpeza', 'Limpieza', 'تنظيف', "Cleaning"],
    ['sur', 'de', 'de', 'من', "of"],
    ['à', 'às', 'a las', 'الساعة', "at"],
    // statuts
    ['Confirmée', 'Confirmada', 'Confirmada', 'مؤكدة', "Confirmed"],
    ['En cours', 'Em curso', 'En curso', 'جارية', "In progress"],
    ['Terminée', 'Terminada', 'Terminada', 'منتهية', "Finished"],
    ['Annulée', 'Cancelada', 'Cancelada', 'ملغاة', "Cancelled"],
    ['Recherche en cours', 'Em procura', 'Buscando', 'جارٍ البحث', "Searching"],
    ['Grand nettoyage', 'Limpeza profunda', 'Limpieza a fondo', 'تنظيف شامل', "Deep cleaning"],
    ['Nettoyage de bureaux', 'Limpeza de escritórios', 'Limpieza de oficinas', 'تنظيف المكاتب', "Office cleaning"],
    ['Ménage Airbnb', 'Limpeza Airbnb', 'Limpieza Airbnb', 'تنظيف Airbnb', "Airbnb cleaning"],
    // semaine, disponibilités, congés
    ['Aucune mission ce jour-là.', 'Nenhuma missão neste dia.', 'Ninguna misión ese día.', 'لا توجد مهمة في هذا اليوم.', "No mission that day."],
    ['Ménage commencé', 'Limpeza começada', 'Limpieza empezada', 'بدأ التنظيف', "Cleaning started"],
    ['Ma semaine', 'A minha semana', 'Mi semana', 'أسبوعي', "My week"],
    ['h de missions', 'h de missões', 'h de misiones', 'ساعات من المهام', "h of missions"],
    ['Congé', 'Folga', 'Libre', 'عطلة', "Day off"],
    ['Indisponible', 'Indisponível', 'No disponible', 'غير متاحة', "Unavailable"],
    ['Dispo', 'Disponível', 'Disponible', 'متاحة', "Free"],
    ['à accepter', 'a aceitar', 'por aceptar', 'للقبول', "to accept"],
    ['Zone claire : vos disponibilités. Les missions et propositions apparaissent dans la journée.', 'Zona clara: as suas disponibilidades. As missões e propostas aparecem no dia.', 'Zona clara: su disponibilidad. Las misiones y propuestas aparecen en el día.', 'المنطقة الفاتحة: أوقات توفرك. تظهر المهام والعروض في اليوم.', "Light area: your availability. Missions and offers appear in the day."],
    ['Mes disponibilités', 'As minhas disponibilidades', 'Mi disponibilidad', 'أوقات توفري', "My availability"],
    ['jours par semaine · modifier', 'dias por semana · alterar', 'días por semana · cambiar', 'أيام في الأسبوع · تعديل', "days a week · edit"],
    ['jour par semaine · modifier', 'dia por semana · alterar', 'día por semana · cambiar', 'يوم في الأسبوع · تعديل', "day a week · edit"],
    ['À remplir', 'Por preencher', 'Por rellenar', 'يجب ملؤها', "To fill in"],
    ['Vous ne recevez des missions que pendant ces horaires.', 'Só recebe missões nestes horários.', 'Solo recibe misiones en este horario.', 'لا تصلك المهام إلا في هذه الأوقات.', "You only get missions during these hours."],
    ['Lundi', 'Segunda-feira', 'Lunes', 'الإثنين', "Monday"],
    ['Mardi', 'Terça-feira', 'Martes', 'الثلاثاء', "Tuesday"],
    ['Mercredi', 'Quarta-feira', 'Miércoles', 'الأربعاء', "Wednesday"],
    ['Jeudi', 'Quinta-feira', 'Jueves', 'الخميس', "Thursday"],
    ['Vendredi', 'Sexta-feira', 'Viernes', 'الجمعة', "Friday"],
    ['Samedi', 'Sábado', 'Sábado', 'السبت', "Saturday"],
    ['Dimanche', 'Domingo', 'Domingo', 'الأحد', "Sunday"],
    ['Disponible', 'Disponível', 'Disponible', 'متاحة', "Available"],
    ['Repos', 'Descanso', 'Descanso', 'راحة', "Rest"],
    ['Enregistrer mes disponibilités', 'Guardar as minhas disponibilidades', 'Guardar mi disponibilidad', 'حفظ أوقات توفري', "Save my availability"],
    ['Mes congés', 'As minhas folgas', 'Mis días libres', 'عطلي', "My days off"],
    ['Aucun congé prévu.', 'Nenhuma folga prevista.', 'Ningún día libre previsto.', 'لا توجد عطلة مبرمجة.', "No days off planned."],
    ['Ajouter le congé', 'Adicionar a folga', 'Añadir el día libre', 'إضافة العطلة', "Add the day off"],
    ['Supprimer', 'Apagar', 'Eliminar', 'حذف', "Delete"],
    // gains et niveau
    ['Mes gains', 'Os meus ganhos', 'Mis ganancias', 'أرباحي', "My earnings"],
    ['Ce mois-ci', 'Este mês', 'Este mes', 'هذا الشهر', "This month"],
    ['Mois dernier', 'Mês passado', 'Mes pasado', 'الشهر الماضي', "Last month"],
    ['ménages terminés', 'limpezas terminadas', 'limpiezas terminadas', 'تنظيفات منتهية', "cleanings finished"],
    ['ménage terminé', 'limpeza terminada', 'limpieza terminada', 'تنظيف منتهٍ', "cleaning finished"],
    ['missions prévues', 'missões previstas', 'misiones previstas', 'مهام مبرمجة', "missions planned"],
    ['mission prévue', 'missão prevista', 'misión prevista', 'مهمة مبرمجة', "mission planned"],
    ['Heures de ménage réalisées. Le salaire figure sur votre fiche de paie.', 'Horas de limpeza feitas. O salário aparece no seu recibo de vencimento.', 'Horas de limpieza realizadas. El salario figura en su nómina.', 'ساعات التنظيف المنجزة. يظهر الراتب في كشف الأجر.', "Cleaning hours worked. Your salary is on your payslip."],
    ['Calculé avec votre tarif de', 'Calculado com a sua tarifa de', 'Calculado con su tarifa de', 'محسوب بأجرك', "Calculated with your rate of"],
    ['avant vos cotisations.', 'antes das suas contribuições.', 'antes de sus cotizaciones.', 'قبل الاقتطاعات.', "before your contributions."],
    ['Historique mois par mois', 'Histórico mês a mês', 'Historial mes a mes', 'السجل شهرًا بشهر', "Month by month"],
    ['Mois', 'Mês', 'Mes', 'الشهر', "Month"],
    ['Ménages', 'Limpezas', 'Limpiezas', 'التنظيفات', "Cleanings"],
    ['Heures', 'Horas', 'Horas', 'الساعات', "Hours"],
    ['Gagné', 'Ganho', 'Ganado', 'المكسوب', "Earned"],
    ['Versé', 'Pago', 'Pagado', 'المدفوع', "Paid"],
    ['📄 Relevé', '📄 Extrato', '📄 Extracto', '📄 الكشف', "📄 Statement"],
    ['de pourboires ce mois-ci', 'de gorjetas este mês', 'de propinas este mes', 'إكراميات هذا الشهر', "in tips this month"],
    ['Bonus de niveau', 'Bónus de nível', 'Bonificación de nivel', 'مكافأة المستوى', "Level bonus"],
    ['Pas encore', 'Ainda não', 'Todavía no', 'ليس بعد', "Not yet"],
    ['Ajouté à chaque versement.', 'Somado a cada pagamento.', 'Se suma a cada pago.', 'يُضاف إلى كل دفعة.', "Added to each payment."],
    ['Au niveau Platine.', 'No nível Platina.', 'En el nivel Platino.', 'في المستوى البلاتيني.', "At Platinum level."],
    ['Semaine du', 'Semana de', 'Semana del', 'أسبوع', "Week of"],
    ['Mon niveau', 'O meu nível', 'Mi nivel', 'مستواي', "My level"],
    ['Bleu', 'Azul', 'Azul', 'أزرق', "Blue"],
    ['Or', 'Ouro', 'Oro', 'ذهبي', "Gold"],
    ['Platine', 'Platina', 'Platino', 'بلاتيني', "Platinum"],
    ['Bienvenue chez Proprigo !', 'Bem-vinda à Proprigo!', '¡Bienvenida a Proprigo!', 'مرحبًا بك في Proprigo!', "Welcome to Proprigo!"],
    ['Vous êtes prioritaire sur les missions proches.', 'Tem prioridade nas missões próximas.', 'Tiene prioridad en las misiones cercanas.', 'لك الأولوية في المهام القريبة.', "You get priority on nearby missions."],
    ['Prioritaire sur les missions et', 'Prioridade nas missões e', 'Prioridad en las misiones y', 'أولوية في المهام و', "Priority on missions and"],
    ["de l'heure", 'por hora', 'por hora', 'في الساعة', "per hour"],
    ['Pour passer', 'Para passar a', 'Para pasar a', 'للانتقال إلى', "To reach"],
    ['priorité sur les missions', 'prioridade nas missões', 'prioridad en las misiones', 'أولوية في المهام', "priority on missions"],
    ['🧽 Ménages terminés', '🧽 Limpezas terminadas', '🧽 Limpiezas terminadas', '🧽 التنظيفات المنتهية', "🧽 Cleanings finished"],
    ['📅 Aucune absence non prévenue (6 mois)', '📅 Nenhuma falta sem aviso (6 meses)', '📅 Ninguna ausencia sin avisar (6 meses)', '📅 لا غياب دون إشعار (6 أشهر)', "📅 No unannounced absence (6 months)"],
    ['⭐ Note moyenne', '⭐ Nota média', '⭐ Nota media', '⭐ متوسط التقييم', "⭐ Average rating"],
    ['La note compte à partir de', 'A nota conta a partir de', 'La nota cuenta a partir de', 'يُحتسب التقييم ابتداءً من', "The rating counts from"],
    ['avis (vous en avez', 'avaliações (tem', 'opiniones (tiene', 'تقييمات (لديك', "reviews (you have"],
    ['Vous avez atteint le plus haut niveau. Merci pour votre travail !', 'Chegou ao nível mais alto. Obrigado pelo seu trabalho!', 'Ha alcanzado el nivel más alto. ¡Gracias por su trabajo!', 'وصلت إلى أعلى مستوى. شكرًا على عملك!', "You have reached the highest level. Thank you for your work!"],
    // notifications
    ['Notifications', 'Notificações', 'Notificaciones', 'الإشعارات', "Notifications"],
    ['Recevez les nouvelles missions sur ce téléphone, même application fermée.', 'Receba as novas missões neste telemóvel, mesmo com a aplicação fechada.', 'Reciba las nuevas misiones en este teléfono, incluso con la aplicación cerrada.', 'تصلك المهام الجديدة على هذا الهاتف حتى والتطبيق مغلق.', "Get new missions on this phone, even when the app is closed."],
    ['Activer les notifications', 'Ativar as notificações', 'Activar las notificaciones', 'تفعيل الإشعارات', "Turn on notifications"],
    ["✓ C'est activé : vous serez prévenu sur ce téléphone.", '✓ Está ativado: será avisada neste telemóvel.', '✓ Activado: recibirá avisos en este teléfono.', '✓ تم التفعيل: ستصلك الإشعارات على هذا الهاتف.', "✓ It's on: you will be notified on this phone."],
    ['Vérifier que ça marche', 'Verificar se funciona', 'Comprobar que funciona', 'تحقّقي أنه يعمل', "Check that it works"],
    ['Ne plus être prévenu', 'Deixar de ser avisada', 'Dejar de recibir avisos', 'إيقاف الإشعارات', "Stop notifications"],
    // documents
    ['Mes documents', 'Os meus documentos', 'Mis documentos', 'وثائقي', "My documents"],
    ["Déposez chaque pièce en PDF ou en photo bien nette (5 Mo maximum). Seule l'équipe Proprigo les voit.", 'Envie cada documento em PDF ou numa foto bem nítida (5 MB no máximo). Só a equipa Proprigo os vê.', 'Envíe cada documento en PDF o en una foto bien nítida (5 MB como máximo). Solo el equipo de Proprigo los ve.', 'أرسلي كل وثيقة بصيغة PDF أو صورة واضحة (5 ميغابايت كحد أقصى). لا يراها إلا فريق Proprigo.', "Upload each document as a PDF or a clear photo (5 MB max). Only the Proprigo team can see them."],
    ['Toutes les pièces obligatoires sont validées. Merci !', 'Todos os documentos obrigatórios estão validados. Obrigado!', 'Todos los documentos obligatorios están validados. ¡Gracias!', 'تم قبول كل الوثائق الإلزامية. شكرًا!', "All required documents are approved. Thank you!"],
    ['Envoyer la nouvelle version', 'Enviar a nova versão', 'Enviar la nueva versión', 'إرسال النسخة الجديدة', "Send the new version"],
    ['Déposer', 'Enviar', 'Subir', 'إرسال', "Upload"],
    ['Remplacer', 'Substituir', 'Sustituir', 'استبدال', "Replace"],
    ["Valable jusqu'au", 'Válido até', 'Válido hasta el', 'صالح حتى', "Valid until"],
    ['Expiré depuis le', 'Expirado desde', 'Caducado desde el', 'منتهي الصلاحية منذ', "Expired since"],
    ['plus que', 'faltam só', 'solo quedan', 'لم يبق إلا', "only"],
    ['Voir', 'Ver', 'Ver', 'عرض', "View"],
    ['Pas encore déposé', 'Ainda não enviado', 'Aún no subido', 'لم يُرسل بعد', "Not uploaded yet"],
    ['(facultatif)', '(opcional)', '(opcional)', '(اختياري)', "(optional)"],
    ['En cours de vérification', 'Em verificação', 'En verificación', 'قيد التحقق', "Being checked"],
    ['Validé', 'Validado', 'Validado', 'مقبول', "Approved"],
    ['À renvoyer', 'Por reenviar', 'Por reenviar', 'يجب إعادة الإرسال', "Send again"],
    ["Pièce d'identité ou titre de séjour en cours de validité", 'Documento de identidade ou autorização de residência válida', 'Documento de identidad o permiso de residencia en vigor', 'بطاقة هوية أو بطاقة إقامة سارية', "Valid ID card, passport or residence permit"],
    ['Attestation de sécurité sociale (ou carte Vitale)', 'Certificado da segurança social (ou cartão Vitale)', 'Certificado de la seguridad social (o tarjeta Vitale)', 'شهادة الضمان الاجتماعي (أو بطاقة Vitale)', "Social security certificate (or Carte Vitale)"],
    ['RIB à votre nom', 'NIB/IBAN em seu nome', 'Datos bancarios (RIB) a su nombre', 'كشف الهوية البنكية باسمك (RIB)', "Bank details (RIB) in your name"],
    ['Avis de situation SIRENE (INSEE) ou extrait Kbis', 'Certificado SIRENE (INSEE) ou extrato Kbis', 'Certificado SIRENE (INSEE) o extracto Kbis', 'شهادة SIRENE (INSEE) أو مستخرج Kbis', "SIRENE notice (INSEE) or Kbis extract"],
    ['Attestation de vigilance URSSAF de moins de 6 mois', 'Certificado de vigilância URSSAF com menos de 6 meses', 'Certificado de vigilancia URSSAF de menos de 6 meses', 'شهادة URSSAF عمرها أقل من 6 أشهر', "URSSAF vigilance certificate less than 6 months old"],
    ["Attestation d'assurance responsabilité civile professionnelle", 'Seguro de responsabilidade civil profissional', 'Seguro de responsabilidad civil profesional', 'شهادة تأمين المسؤولية المدنية المهنية', "Professional liability insurance certificate"],
    ['Extrait de casier judiciaire (bulletin n° 3)', 'Registo criminal (boletim n.º 3)', 'Certificado de antecedentes penales (boletín n.º 3)', 'صحيفة السوابق العدلية (النشرة رقم 3)', "Criminal record extract (bulletin no. 3)"],
    // aide
    ['Les réponses aux questions les plus fréquentes. Pour une mission précise, écrivez dans les 💬 messages de la mission.', 'As respostas às perguntas mais frequentes. Para uma missão concreta, escreva nas 💬 mensagens da missão.', 'Las respuestas a las preguntas más frecuentes. Para una misión concreta, escriba en los 💬 mensajes de la misión.', 'إجابات الأسئلة الأكثر شيوعًا. لمهمة معيّنة، اكتبي في 💬 رسائل المهمة.', "Answers to the most common questions. For a specific mission, write in the mission's 💬 messages."],
    ['Comment je reçois mes missions ?', 'Como recebo as minhas missões?', '¿Cómo recibo mis misiones?', 'كيف تصلني المهام؟', "How do I get my missions?"],
    ["Indépendante : vous recevez des propositions dans « Missions », avec le prix, la date et le code postal. Vous acceptez celles qui vous conviennent ; refuser n'entraîne aucune pénalité. L'adresse exacte s'affiche après acceptation. Salariée : le planning Proprigo vous attribue les missions selon vos disponibilités.", 'Independente: recebe propostas em «Missões», com o preço, a data e o código postal. Aceita as que lhe convêm; recusar não tem penalização. A morada exata aparece depois de aceitar. Assalariada: o planeamento Proprigo atribui-lhe as missões segundo as suas disponibilidades.', 'Autónoma: recibe propuestas en «Misiones», con el precio, la fecha y el código postal. Acepta las que le convienen; rechazar no tiene penalización. La dirección exacta aparece tras aceptar. Asalariada: la planificación de Proprigo le asigna las misiones según su disponibilidad.', 'المستقلة: تصلك العروض في «المهام» مع السعر والتاريخ والرمز البريدي. تقبلين ما يناسبك، والرفض بلا عقوبة. يظهر العنوان الكامل بعد القبول. الموظفة: يوزع فريق التخطيط المهام حسب أوقات توفرك.', "Self-employed: you receive offers in “Missions”, with the price, date and postcode. Accept the ones that suit you; declining has no penalty. The exact address appears after you accept. Employee: the Proprigo schedule assigns your missions based on your availability."],
    ['Comment être prévenue des nouvelles missions ?', 'Como ser avisada das novas missões?', '¿Cómo recibir aviso de las nuevas misiones?', 'كيف تصلني إشعارات المهام الجديدة؟', "How do I get told about new missions?"],
    ["Activez les notifications dans « Missions », rubrique « Notifications ». Vous êtes prévenue sur votre téléphone, même l'application fermée.", 'Ative as notificações em «Missões», secção «Notificações». É avisada no telemóvel, mesmo com a aplicação fechada.', 'Active las notificaciones en «Misiones», apartado «Notificaciones». Recibirá avisos en el teléfono, incluso con la aplicación cerrada.', 'فعّلي الإشعارات في «المهام»، قسم «الإشعارات». تصلك على الهاتف حتى والتطبيق مغلق.', "Turn on notifications in “Missions”, section “Notifications”. You are notified on your phone, even when the app is closed."],
    ['Comment indiquer mes horaires et mes congés ?', 'Como indicar os meus horários e folgas?', '¿Cómo indico mi horario y mis días libres?', 'كيف أحدد أوقاتي وعطلي؟', "How do I set my hours and days off?"],
    ["Dans « Missions » : « Mes disponibilités » pour vos jours et horaires de travail, « Mes congés » pour vos absences. Vous ne recevez aucune mission en dehors de ces horaires ni pendant vos congés.", 'Em «Missões»: «As minhas disponibilidades» para os dias e horários de trabalho, «As minhas folgas» para as ausências. Não recebe missões fora destes horários nem durante as folgas.', 'En «Misiones»: «Mi disponibilidad» para sus días y horarios, «Mis días libres» para sus ausencias. No recibe misiones fuera de ese horario ni en sus días libres.', 'في «المهام»: «أوقات توفري» لأيام وساعات العمل، و«عطلي» لأيام الغياب. لا تصلك مهام خارج هذه الأوقات ولا أثناء العطل.', "In “Missions”: “My availability” for your working days and hours, “My days off” for your absences. You get no missions outside these hours or during your days off."],
    ['Le jour de la mission, que dois-je faire ?', 'No dia da missão, o que devo fazer?', 'El día de la misión, ¿qué debo hacer?', 'ماذا أفعل يوم المهمة؟', "On the day of the mission, what do I do?"],
    ["Appuyez sur 🚶 « Je pars » en partant et indiquez dans combien de temps vous arrivez : le client est prévenu. Puis 📍 « Je suis arrivée », ▶ « Commencer le ménage », et ✅ « Terminer le ménage » à la fin. Cochez les tâches au fur et à mesure.", 'Carregue em 🚶 «Vou a caminho» ao sair e indique daqui a quanto tempo chega: o cliente é avisado. Depois 📍 «Cheguei», ▶ «Começar a limpeza» e ✅ «Terminar a limpeza» no fim. Marque as tarefas à medida que as faz.', 'Pulse 🚶 «Salgo» al salir e indique en cuánto tiempo llega: el cliente recibe aviso. Luego 📍 «He llegado», ▶ «Empezar la limpieza» y ✅ «Terminar la limpieza» al final. Marque las tareas a medida que las hace.', 'اضغطي 🚶 «أنا في الطريق» عند الخروج وحددي بعد كم من الوقت تصلين: يتم إعلام الزبون. ثم 📍 «وصلت» و▶ «ابدئي التنظيف» و✅ «إنهاء التنظيف» في النهاية. أشّري على المهام أولًا بأول.', "Tap 🚶 “I'm leaving” when you set off and say how soon you will arrive: the client is told. Then 📍 “I've arrived”, ▶ “Start the cleaning”, and ✅ “Finish the cleaning” at the end. Tick the tasks as you go."],
    ['Je vais être en retard, que faire ?', 'Vou chegar atrasada, o que faço?', 'Voy a llegar tarde, ¿qué hago?', 'سأتأخر، ماذا أفعل؟', "I'm going to be late, what should I do?"],
    ["Ouvrez 💬 « Messages » sur la mission et envoyez « J'aurai environ 15 min de retard ». Vous pouvez aussi changer l'heure d'arrivée prévue après « Je pars ».", 'Abra 💬 «Mensagens» na missão e envie «Vou chegar uns 15 min atrasada». Também pode mudar a hora de chegada prevista depois de «Vou a caminho».', 'Abra 💬 «Mensajes» en la misión y envíe «Llegaré unos 15 min tarde». También puede cambiar la hora de llegada prevista tras «Salgo».', 'افتحي 💬 «الرسائل» في المهمة وأرسلي «سأتأخر حوالي 15 دقيقة». يمكنك أيضًا تغيير وقت الوصول بعد «أنا في الطريق».', "Open 💬 “Messages” on the mission and send “I'll be about 15 min late”. You can also change your expected arrival time after “I'm leaving”."],
    ['Il y a un problème chez le client', 'Há um problema em casa do cliente', 'Hay un problema en casa del cliente', 'هناك مشكلة عند الزبون', "There is a problem at the client's home"],
    ["Appuyez sur ⚠️ « Problème » sur la mission : accès impossible, objet cassé, logement bien plus sale que prévu, ou si vous ne vous sentez pas en sécurité. L'équipe est prévenue tout de suite. En cas de danger, appelez le 17.", 'Carregue em ⚠️ «Problema» na missão: acesso impossível, objeto partido, casa muito mais suja do que o previsto, ou se não se sentir segura. A equipa é avisada de imediato. Em caso de perigo, ligue 17.', 'Pulse ⚠️ «Problema» en la misión: acceso imposible, objeto roto, vivienda mucho más sucia de lo previsto, o si no se siente segura. El equipo recibe aviso al momento. En caso de peligro, llame al 17.', 'اضغطي ⚠️ «مشكلة» في المهمة: تعذّر الدخول، شيء مكسور، منزل أوسخ بكثير من المتوقع، أو إن لم تشعري بالأمان. يُبلَّغ الفريق فورًا. في حالة الخطر، اتصلي بالرقم 17.', "Tap ⚠️ “Problem” on the mission: can't get in, something broken, home much dirtier than expected, or if you don't feel safe. The team is told straight away. If you are in danger, call 17."],
    ['Les photos sont-elles obligatoires ?', 'As fotos são obrigatórias?', '¿Las fotos son obligatorias?', 'هل الصور إلزامية؟', "Are photos required?"],
    ["Seulement si le client les a acceptées. Dans ce cas, prenez au moins une 📷 « Photo après » avant de terminer. Sinon, aucune photo n'est demandée.", 'Só se o cliente as aceitou. Nesse caso, tire pelo menos uma 📷 «Foto depois» antes de terminar. Caso contrário, não são pedidas fotos.', 'Solo si el cliente las aceptó. En ese caso, tome al menos una 📷 «Foto después» antes de terminar. Si no, no se pide ninguna foto.', 'فقط إذا وافق الزبون عليها. في هذه الحالة التقطي على الأقل 📷 «صورة بعد» قبل الإنهاء. وإلا فلا صور مطلوبة.', "Only if the client accepted them. In that case, take at least one 📷 “After photo” before finishing. Otherwise, no photos are needed."],
    ['Quand suis-je payée ?', 'Quando sou paga?', '¿Cuándo me pagan?', 'متى أتقاضى أجري؟', "When do I get paid?"],
    ['Indépendante : par virement chaque semaine pour les ménages terminés. Salariée : votre salaire figure sur votre fiche de paie. Dans les deux cas, « Mes gains » montre vos heures mois par mois.', 'Independente: por transferência todas as semanas pelas limpezas terminadas. Assalariada: o salário aparece no recibo de vencimento. Nos dois casos, «Os meus ganhos» mostra as horas mês a mês.', 'Autónoma: por transferencia cada semana por las limpiezas terminadas. Asalariada: su salario figura en la nómina. En ambos casos, «Mis ganancias» muestra sus horas mes a mes.', 'المستقلة: بتحويل بنكي كل أسبوع عن التنظيفات المنتهية. الموظفة: يظهر الراتب في كشف الأجر. في الحالتين، يعرض «أرباحي» ساعاتك شهرًا بشهر.', "Self-employed: by bank transfer every week for finished cleanings. Employee: your salary is on your payslip. In both cases, “My earnings” shows your hours month by month."],
    ['Je ne peux pas venir à une mission', 'Não posso ir a uma missão', 'No puedo ir a una misión', 'لا أستطيع الحضور إلى مهمة', "I can't make it to a mission"],
    ["Prévenez l'équipe le plus tôt possible par e-mail à contact@proprigo.fr, en donnant la date et l'adresse de la mission. Une remplaçante sera cherchée pour le client. Pour une absence prévue, ajoutez-la dans « Mes congés ».", 'Avise a equipa o mais cedo possível por e-mail para contact@proprigo.fr, com a data e a morada da missão. Será procurada uma substituta para o cliente. Para uma ausência prevista, adicione-a em «As minhas folgas».', 'Avise al equipo lo antes posible por correo a contact@proprigo.fr, con la fecha y la dirección de la misión. Se buscará una sustituta para el cliente. Para una ausencia prevista, añádala en «Mis días libres».', 'أبلغي الفريق في أقرب وقت عبر البريد contact@proprigo.fr مع تاريخ وعنوان المهمة. سنبحث عن بديلة للزبون. للغياب المبرمج، أضيفيه في «عطلي».', "Tell the team as early as possible by email at contact@proprigo.fr, with the date and address of the mission. We will look for a replacement for the client. For a planned absence, add it in “My days off”."],
    ['Où envoyer mes documents ?', 'Onde envio os meus documentos?', '¿Dónde envío mis documentos?', 'أين أرسل وثائقي؟', "Where do I send my documents?"],
    ['Dans « Missions », rubrique « Mes documents ». Vous pouvez envoyer une photo ou un PDF depuis votre téléphone.', 'Em «Missões», secção «Os meus documentos». Pode enviar uma foto ou um PDF a partir do telemóvel.', 'En «Misiones», apartado «Mis documentos». Puede enviar una foto o un PDF desde su teléfono.', 'في «المهام»، قسم «وثائقي». يمكنك إرسال صورة أو ملف PDF من هاتفك.', "In “Missions”, section “My documents”. You can send a photo or a PDF from your phone."],
    ["Contacter l'équipe", 'Contactar a equipa', 'Contactar al equipo', 'التواصل مع الفريق', "Contact the team"],
    ["Par la messagerie d'une mission, ou par e-mail :", 'Pelas mensagens de uma missão, ou por e-mail:', 'Por los mensajes de una misión, o por correo:', 'عبر رسائل المهمة، أو عبر البريد:', "Through a mission's messages, or by email:"],
    // compte
    ['🌐 Langue', '🌐 Língua', '🌐 Idioma', '🌐 اللغة', "🌐 Language"],
    ['Ma présentation aux clients', 'A minha apresentação aos clientes', 'Mi presentación a los clientes', 'تقديمي للزبائن', "How I introduce myself to clients"],
    ['📷 Ma photo', '📷 A minha foto', '📷 Mi foto', '📷 صورتي', "📷 My photo"],
    ['Ajouter ma photo', 'Adicionar a minha foto', 'Añadir mi foto', 'إضافة صورتي', "Add my photo"],
    ['Changer la photo', 'Mudar a foto', 'Cambiar la foto', 'تغيير الصورة', "Change the photo"],
    ['Visible des clients', 'Visível para os clientes', 'Visible para los clientes', 'ظاهرة للزبائن', "Visible to clients"],
    ['🏦 Mon compte bancaire', '🏦 A minha conta bancária', '🏦 Mi cuenta bancaria', '🏦 حسابي البنكي', "🏦 My bank account"],
    ['Pour recevoir vos versements.', 'Para receber os seus pagamentos.', 'Para recibir sus pagos.', 'لاستلام دفعاتك.', "To receive your payments."],
    ['Compte enregistré :', 'Conta registada:', 'Cuenta registrada:', 'الحساب المسجل:', "Account saved:"],
    ['Aucun compte enregistré.', 'Nenhuma conta registada.', 'Ninguna cuenta registrada.', 'لا يوجد حساب مسجل.', "No account saved."],
    ["L'équipe est prévenue à chaque changement.", 'A equipa é avisada a cada alteração.', 'El equipo recibe aviso de cada cambio.', 'يُبلَّغ الفريق عند كل تغيير.', "The team is told about every change."],
    ['Titulaire du compte', 'Titular da conta', 'Titular de la cuenta', 'صاحب الحساب', "Account holder"],
    ['Changer de compte', 'Mudar de conta', 'Cambiar de cuenta', 'تغيير الحساب', "Change account"],
    ['Enregistrer mon IBAN', 'Guardar o meu IBAN', 'Guardar mi IBAN', 'حفظ رقم IBAN', "Save my IBAN"],
    ['Se déconnecter', 'Terminar sessão', 'Cerrar sesión', 'تسجيل الخروج', "Log out"],
  ];
  const IDX = { pt: 1, es: 2, ar: 3, en: 4 };
  const LOCALE = { fr: 'fr-FR', en: 'en-GB', pt: 'pt-PT', es: 'es-ES', ar: 'ar' };
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
  window.PROPRIGO_I18N = { set, translate, get lang() { return current; }, locale: () => LOCALE[current], LANGS: [['fr', 'Français'], ['en', 'English'], ['pt', 'Português'], ['es', 'Español'], ['ar', 'العربية']] };
}());
