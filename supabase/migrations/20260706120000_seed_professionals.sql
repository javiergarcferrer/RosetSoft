-- Seed the CRM professionals list from the team's spreadsheet
-- ("Profesionales ALCOVER — Sheet WA"): the decorators / architects /
-- interior designers the showroom works with.
--
-- Mapping from the sheet
-- ----------------------
--   • NAME      — many entries carry the team's own number as a "NN-" prefix
--                 ("68-Mariel Pimentel"); that number lands in `number` and the
--                 prefix is stripped from `name`. Unnumbered entries get a NULL
--                 number — the app's assignSequenceNumber keeps allocating from
--                 max(number)+1 for rows created in the UI, so nothing clashes.
--   • EMAIL     — as-is (a "." placeholder treated as empty).
--   • PHONE     — as-is.
--   • DIRECCIÓN — into `notes`: it mixes delivery addresses with contact
--                 remarks ("Sale la contestadora", "Retirar en tienda"), so the
--                 freeform notes field is its honest home.
--   • CANTIDAD DE REVISTAS — empty for every row; dropped.
--
-- Idempotent + safe against existing data:
--   • a professional whose name already exists for the team profile is skipped
--     (re-running the migration, or a pro someone already typed in by hand);
--   • a sheet number already taken in `professionals` (per the
--     UNIQUE(profile_id, number) constraint) is dropped to NULL rather than
--     aborting the insert;
--   • ids are deterministic (md5 of the name) so re-runs can't double-insert.
--
-- `default_commission_pct` stays at the table default (10%) — the sheet carries
-- no commission info; the real rate is set per quote (Piso 15% / Especial 20%).
with seed(num, name, email, phone, notes) as (
  values
  (68, 'Mariel Pimentel', 'marielpi@hotmail.com', '829-259-4514', 'Alberto Larancuent # 13 Torre M2 Apto 40 A, Naco'),
  (82, 'Elisa Ventura', 'etvconstrucciones@gmail.com', '829-770-6234', 'Apartamento de Paola, C. Elipse 26, Edificio Paola Maria VII'),
  (66, 'Francisco Guzmán', 'guzmanfrco@gmail.com', '809-256-5514', 'Av. Jesús Galíndez 9, Santiago de los Caballeros- Francisco Guzman, SRL'),
  (57, 'Julissa Alcantara', 'julissaalcantara@gmail.com', '809-850-5065', 'Av. Luperón # 26 Esquina Maireni Residencial Maireni I Edificio 5 apto 201'),
  (32, 'Daniella Betances', 'dbcinteriores@gmail.com', '809-712-0215', 'Ave. Anacaona #73 Torre anacaona primera Apto 201 Entre defillo y nulez de caceres Torre crema con toldos marrones'),
  (33, 'Ramón Emilio Jimenez', 'romilio@arquimilio.com', '809-697-6063', 'Ave. Mirador sur 1 A - Oficina Arquimilio'),
  (28, 'Iranna Canaan', 'irannacanaan@claro.net.do', '809-993-2111', 'Ave. Roberto pastoriza # 208 - Alta Casa Ensanche Naco'),
  (29, 'Lauren Lama', 'laurenlama18@gmail.com', '809-994-2111', 'Ave. Roberto pastoriza # 208 - Alta Casa Ensanche Naco'),
  (18, 'Patricia Alvarez', 'patricia@insideiconos.com', '809-299-7000', 'Ave. Simon Bolivar #225 Esq. calle primera Plaza G Local 7'),
  (95, 'Irene Mercado', 'irenemercado7@hotmail.com', '809-865-4175', 'Calle 2 A Torre Avanti Ensanche Paraiso ( dejar en el Lobby con Diony )'),
  (56, 'Judith Santos', 'santosjudith@hotmail.com', '809-994-3444', 'Calle Agustin Lara # 25 Piantini . --- Empresa Marquesa'),
  (null, 'Marcelle Lama', 'proyectos@marcellelama.com', '809-660-0303', 'Calle Agustin Lara #24, Piantini'),
  (52, 'Marina Silverio', 'marinasilverioc@gmail.com', '809-704-8884', 'Calle Agustin Lara # 2 , Piantini - Estudio Marina'),
  (12, 'Wendy Diaz', 'wendydiazmetz@gmail.com', '809-624-7864', 'Calle Altagracia Saviñon # 19 Los Prados III'),
  (7, 'Danilo Rodio', 'danilo.rodio@gmail.com', '809-865-2933', 'Calle Andres Julio Aybar #18 Tienda Venini'),
  (8, 'Jorge Luis Gutierrez', 'info@gutierrezrodio.com', '829-470-4508', 'Calle Andres Julio Aybar #18 Tienda Venini'),
  (48, 'Nurys Risk', 'nriskb@gmail.com', '809-545-0852', 'Calle Bienvenido Garcia Gautiaer #30 Residencial la parcela Nivel 2 Arroyo Hondo Viejo'),
  (null, 'Mariela Montas', 'sit.mobiliarios@gmail.com', '809-383-7838', 'Calle Cesar Nicolas Penson Esq. Calle los Robles Edificio TPA Local 3 Segundo piso, La esperilla'),
  (13, 'Lucy Martinez', 'lucymartinezsosa@yahoo.com', '809-654-9845', 'Calle Cub Scouts #37 Detras de Claro, Ensanche Naco'),
  (22, 'Cynthia Busto', 'c.bustorod@gmail.com', '809-805-9793', 'Calle el Cayao #20 Ensanche Serrallés'),
  (42, 'Doña Sarah Hernández', 'saritajulian@gmail.com', '809-544-4394', 'Calle Fabio Mota 1 Edificio Cecilia B Apto 3 C , Naco - Oficina'),
  (43, 'Sara Ines Hernández', 'sarimyh@gmail.com', '829-910-0565', 'Calle Fabio Mota 1 Edificio Cecilia B Apto 3 C , Naco - Oficina'),
  (44, 'Rossa Hernández', 'rosiherjul@yahoo.com', '809-224-4999', 'Calle Fabio Mota 1 Edificio Cecilia B Apto 3 C , Naco - Oficina'),
  (null, 'Sarah Piantini', 'info@intsideids.com', '829-961-4884', 'Calle Federico Geraldino #48, Edificio Piaressa, 1er. Nivel, Ens. Piantini,'),
  (null, 'Gabriela Stefan', 'info@intsideids.com', '809-890-8034', 'Calle Federico Geraldino #48, Edificio Piaressa, 1er. Nivel, Ens. Piantini,'),
  (86, 'Americo Martinez', 'americomartinez@gmail.com, darquin@codetel.net.do', '809-381-4444', 'Calle Federico Geraldino 23 - Casa Marti'),
  (63, 'Raysa Peña', 'eventosydec_raysa@hotmail.com', '829-916-6000', 'Calle Fernando Escobar Hurtado , casi esq. agustin Lara , Torre alimar 11 apto 2 B seralles ( Dejar en el lobby )'),
  (20, 'Andres Aybar', 'aybarabud@gmail.com', '809-935-3733', 'Calle Filomena gomez de Cova #253 Serallés - El Estudio Store'),
  (26, 'Grace Cornielle', 'grace.cornielle@gmail.com', '809-224-2457', 'Calle Filomena Gomez de Cova # 1 , Corporativo 2015 # 8 Local 10'),
  (76, 'Hector Bolivar', 'diagram.std@gmail.com', '809-961-9081', 'Calle Filomena Gomez de Cova 6 Condominio Xiomara Bloque C'),
  (30, 'Kim Alvarez', 'contempodis@gmail.com', '809-710-0028', 'Calle Filomena Gomez de Cova 6 Condominio Xiomara Bloque C'),
  (49, 'Gina Duarte', 'ginaduarte_12@hotmail.com', '809-383-1531', 'Calle General Cambiaso # 8 Torre Arche 3 Apto 11 A, Ensanche Naco'),
  (null, 'Lisa Azar', 'design@artisanatstudio.com', '809-707-5220', 'Calle Jacinto Mañón #17, Plaza 17, 2do nivel. Artisanat Design Studio'),
  (62, 'Natali Morales', 'nmorales@homeset.com.do', '829-808-0343', 'Calle Los rios Plaza Bernabe Local de bm cargo - Entregar a Mario'),
  (45, 'Gina Capano', 'ginacapano@gmail.com', '809-980-8404', 'Calle Maguey # 4 Frente al Botanico'),
  (80, 'Olga Capano', 'ocapano@yahoo.com', '809-848-8808', 'Calle Maguey # 4 Frente al Botanico'),
  (5, 'Ivette Medina', 'ivettemedina28@gmail.com', '809-545-4358', 'Calle Manuel de Jesus Troncoso #20 Edificio Don Carlos 10 Piso 8'),
  (6, 'Laura Gamundi', 'lauragamundi@gmail.com', '809-307-4012', 'Calle Max Henriquez ureña # 1 Ensanche Naco'),
  (9, 'Felipe Rangel', 'arquitectorangel@gmail.com', '809-879-1165', 'Calle Max Henriquez ureña # 12 Ensanche Naco'),
  (91, 'Sandra Ehlert', 'sehlert@sandraehlert.com', '809-566-1283', 'Calle No. 2 Casa , Sto Dgo .'),
  (31, 'Douglas Bernard', 'douglasdernardstudio@gmail.com', '829-601-2429', 'Calle paseo de los locutores #45'),
  (78, 'Jaydy Pumarol', 'jaidyp@hotmail.com', '809-850-2490', 'Calle prolongación arabia, Residencial Quintas del parque Casa 4 Arroyo Hondo'),
  (null, 'Jorge Brown Cott', 'jebrowncott@gmail.com', '809-299-2773', 'Calle Rafael Augusto Sanchez 96B Torre Toscana Evaristo Morales - (Dejar lobby )'),
  (21, 'Xiomara Alcantara', 'ambiancedyd@gmail.com', '809-543-3460', 'Calle Ramon corripio # 23, Ensanche Naco'),
  (64, 'Laura Leslie', '2lstudiord@gmail.com', '829-986-4425', 'Calle retiro 2 Torre modena # 1 Pinatini , apto 10'),
  (65, 'Claudia Leslie', '2lstudiord@gmail.com', '829-986-4425', 'Calle retiro 2 Torre modena # 1 Pinatini , apto 10'),
  (77, 'Patricia Villegas', 'contacto@patriciavillegas.com', '809-481-3780', 'Calle Victor Garrido Puello # 14 Torre Villa palmera XVI ( dejar en el lobby con atencion Patricia Villegas)'),
  (15, 'Liza Palacios', 'liza@indescorp.com', '809-481-4585', 'Constructora Ginaka- Nuñez de caceres # 23 Bella Vista , frente al colegio Carol Morgan'),
  (16, 'Gina Haché', 'ginahache@hotmail.com', '809-864-0066', 'Constructora Ginaka- Nuñez de caceres # 23 Bella Vista , frente al colegio Carol Morgan'),
  (17, 'Karen Haché', 'karenhacheperez@gmail.com', '809-545-4545', 'Constructora Ginaka- Nuñez de caceres # 23 Bella Vista , frente al colegio Carol Morgan'),
  (null, 'Karla Joubert', '', '809-815-1404', 'Edif, Av. Roberto Pastoriza no.16, Santo Domingo 10121- Joubert & Co'),
  (25, 'Ana Patricia Rodriguez', 'rodriguez.anapatricia@gmail.com', '809-890-2776', 'Eugenio Deschamps # 34 Edificio corporativo Get One Local 201, Los Prados'),
  (34, 'Jacqueline Elhage', 'jaqueline@hageco.com', '809-383-1127', 'Federico Geraldino # 53 Esq. fantino Falco, Piantini - Oficina Hageco'),
  (38, 'Antonia Ramos', 'antoniaramosh@gmail.com', '809-804-1986', 'Gustavo Mejia Ricart #128, Edif. ELAB Suite 105. ----512 Designstudio'),
  (39, 'Nicole Garrido', 'ngarridoelias@gmail.com', '809-978-8262', 'Gustavo Mejia Ricart #128, Edif. ELAB Suite 105. ----512 Designstudio'),
  (71, 'Betzy Jimenez', 'ajestudiosrl@hotmail.com', '809-924-4479', 'C/Emil Boyrie de Moya casi esq Paseo de los Locutores 18evaristo'),
  (10, 'Zaida Sanz', 'zs@sbarquitectos.com.do', '809-330-0933', 'Isabel de Torres 13, Residencial Villa Bendicion , Casa C'),
  (11, 'Terisha Lluberes', 'tll@sbarquitectos.com.do', '829-470-4508', 'Isabel de Torres 13, Residencial Villa Bendicion , Casa C'),
  (72, 'Cristal Garcia', 'cristalgarciallano@gmail.com', '829-941-5047', 'Luis F. Thomen # 162 Evaristo Morales'),
  (35, 'Patricia Valverde', 'patricvalverde@yahoo.com', '829-601-4403', 'Calle Higuamo # 10 entrada C Los Rios'),
  (36, 'Lisandra Alburquerque', 'lisialburquerque@gmail.com', '809-481-1598', 'Sale la contestadora'),
  (37, 'Raquel Fiallo', 'raquelfiallo@idesignrd.com', '809-350-9602', 'Calle Tony mota ricart # 30 Gazcue'),
  (47, 'Sofia Suarez', 'sofia@sanojarisek.com', '809-567-1583', 'Andrés Julio Aybar#15.A Piantini. Detrás del Banco popular Lope de Vega y al lado del Restaurante Ajuala.'),
  (53, 'Jeannette Ruiz', 'jruizinteriordesign@gmail.com', '809-881-1044', 'Calle Porfirio herrera Plaza Maura Nivel 3 Local 303'),
  (61, 'Catherine Cury', 'ckury@homeset.com.do', '829-420-3350', 'Calle socrates Nolasco 13 piso 9 Naco,Torre Londres II'),
  (67, 'Lissette Fernandez', 'lissy.fdez@gmail.com', '809-696-4990', 'Sale la contestadora'),
  (70, 'Carolina Llerandi', 'carolinallerandi@gmail.com', '829-342-6652', 'Luis F. Thomen # 162 Evaristo Morales'),
  (74, 'Lucienne Carlo', 'lucienne.carlo@gmail.com', '809-909-1174', 'Sale la contestadora'),
  (89, 'Georgia Read', 'georgiareid@reidbaquero.com', '809-686-0858', 'No contesta'),
  (27, 'Grays Cornielle', 'alliene_cornielle@hotmail.com', '809-224-2454', 'La dirección es Corporativo 2015 Local 810 Cabinet Cornielle Es en la Filomena gomez de cova #1'),
  (59, 'Lorena Jimenez', 'info@decorfiles.com', '', 'No. Equivocado'),
  (73, 'Loriann Rosario', 'loriannrv@gmail.com', '809-707-7071', 'No. Equivocado'),
  (58, 'Rosa Penzo', 'rvpg@hotmail.com', '809-779-9842', 'Paseo de los Bambúes casa #92 Residencial los Bambúes Altos de arroyo hondo tercero Casa verde esquina'),
  (69, 'Jon de la Nava', 'jon@delanava.com', '829-421-6078', 'Terrenas village apto 101 La bonita, Las terrenas'),
  (60, 'Laura Subero', '', '809-965-3003', 'Torre luz 2 Calle Federico Geraldino, 92, Apto 602 Piantini'),
  (96, 'Batty Acra', 'battyacra@hotmail.com', '809-883-9661', 'Torre monticello Jose maria escriva 73 Piso 9 Piantini'),
  (97, 'Rosalia Feris', 'ro.feris@hotmail.com', '809-519-4212', 'Torre monticello Jose maria escriva 73 Piso 9 Piantini'),
  (40, 'Ysaura Vasquez', 'isaurainteriores@hotmail.com', '809-7570431', 'Vendrá a retirar en la tienda .'),
  (23, 'Rita Brugal', 'rita.brugal@hotmail.com', '809-545-0091', 'Viriato Fiallo #5 Plaza Valoria Local #1 Ensanche Julieta'),
  (null, 'LIli Hache', '', '809-993-5548', 'Av. Roberto Pastoriza # 411. Oficina en la tienda LMH'),
  (null, 'Carlos Colomé', '', '829-454-3879', 'Calle Jose andres aybar Castellanos 103 FR Residences XXII Piso E12'),
  (null, 'Eloise Mota', '', '829-6198352', 'Calle Jose andres aybar Castellanos 103 FR Residences XXII Piso E13'),
  (1, 'Alexandra Guzmán', 'administracion@aginteriores.com.do', '809-563-0467', 'Calle Dr. luis Escoto Gomez # 5 Edificio Padal, Apto 1A Urb. Lopez de Vega Oficina Campagna Ricart y Asociados'),
  (2, 'Alba Bogaert', 'decoalba@hotmail.com', '809-307-2806', 'Respaldo Agustín Lara no 10, Torre Zen, piso 8, Serralles'),
  (3, 'Tania Caceres', 't_caceres@hotmail.com', '809-850-6062', 'Respaldo Agustín Lara no 10, Torre Zen, piso 8, Serralles'),
  (4, 'Maria Eugenia Rubio', 'palazzo@codetel.net.do', '809-696-1392', ''),
  (14, 'Jesus Hernández', 'jesus.hr@outlook.com', '809-879-3449', 'Calle los Laureles #3, Residencial Villa los Laureles, Las Praderas'),
  (24, 'Patricia Jarp', 'patricia.jarp@gmail.com', '809-868-4586', 'Calle tercera de la Quinta, Res Piazza del campo casa # 1, Quintas de cuesta hermosa en cuesta Hermosa III'),
  (41, 'Lucia Freites', 'info@luciafreites.com', '849-354-6554', 'No contesta'),
  (46, 'Jeannette Sanoja', 'jeannette@sanojarisek.com', '809-430-1584', 'Andrés Julio Aybar#15.A Piantini. Detrás del Banco popular Lope de Vega y al lado del Restaurante Ajuala.'),
  (54, 'Carolina Cuello', 'ccuello@carolinacuello.com', '829-563-4861', 'C/ Miguel Angel Monclus #61, Torre Lilas del Mirador 601'),
  (55, 'Doris Martinez', 'sirod.martinez@gmail.com', '829-540-0116', 'No contenta, se le escribió'),
  (75, 'Savery Frias', 'saveryfrias@yahoo.com', '829-727-4480', 'Calle Teodoro chasseriau esquina Guarocuya, Plaza Imperia Local 3 C'),
  (79, 'Aimee Arbaje', 'aimeearbaje@hotmail.com', '809-707-1817', 'Federico Geraldino # 54 Torre Prado Alto Apto 1302'),
  (81, 'Germania Polanco', 'germaniapolanco@yahoo.com', '809-850-3111', 'Retirar en Tienda'),
  (83, 'Maribel Antigua', 'mantigua@pannello.com.do', '809-848-8281', 'Av. 27 de Febrero #545 Entre Privada y Caonabo'),
  (84, 'Patricia Hane', 'hello@patriciahane.com', '829-713-8264', 'Calle Parabola #81 Edificio JJ ( blaco con gris) Apto 3 A Urbanizacion Fernandez , Frente al parque Urbanizacion Fernandez'),
  (85, 'Sonia Francisco', 'sonia.frco2@me.com', '809-780-1212', 'No. Equivocado'),
  (92, 'Natalia Jimenez', 'naty@njdesigns.com.do', '849-886-9047', 'Sale la contestadora'),
  (93, 'Karina Fabian', 'karinafabian@gmail.com', '809-697-1757', 'No contesta, se le escribió'),
  (94, 'Sofia Camilo', 'sofiacamilocabrero@icloud.com', '809-224-0211', 'No contesta, se le escribió'),
  (98, 'Fatima Arbaje', 'fatimaarbaje@hotmail.com', '809-543-8959', 'Torre Almaden V en calle paseo de los locutores #12'),
  (99, 'Yari Del Orbe', 'a3studio@gmail.com', '829-721-0050', 'C/ Paseo de los Locutores esq C/ Seminario, Edif Ginza Dominicana'),
  (null, 'Amanda Musa', 'info@amandamusa.com', '809-350-8404', ''),
  (null, 'Carmen Pastor', '', '829-221-2700', 'Calle Rafael Augusto sanchez 19, Torre villa Palmera XX Apto 8 F , Naco'),
  (null, 'Andrea Harper', '', '809-861-0222', 'Torre Punta Sur by Ginaka, Av Anacaona equina Caonabo piso 24'),
  (null, 'Vera Lucia', 'info@vralucia.com', '849-220-2090', 'C/ Mustafa Kemal #7, Torre Cumbre X piso 10 Oeste Naco'),
  (null, 'Steffanie Anglada', '', '809-544-0229', 'Plaza Paulette Segundo nivel (arriba de Tupaq)'),
  (null, 'Mariale Bordas', '', '829-548-3398', 'C/Jose Amado Soler #58. Condominio Dolmen apt303'),
  (null, 'Alexia Cabrera', 'alexiacabhache@gmail.com', '829-568-1100', 'Sale la contestadora'),
  (null, 'Bella Baez', '', '809-878-2641', 'Erick LEONARD Ekman 63. View House. Casa 11, Arroyo Hondo'),
  (null, 'Maria Gabriela Mendoza', '', '809-860-3272', 'Gustavo Mejia Ricart # 112 Piantini'),
  (null, 'Maria Salome de Montero', '', '809-966-3141', 'Av. Lope de vega No.59 Plaza Lope de Vega Local C-9 Tercer piso, Ensanche Naco'),
  (null, 'Claudia Dina', 'info@claudinadinainteriores.com', '809-390-5876', 'Calle el retiro No 55 Torre Monaco VIII Y IX Esquina jose amado Soler ( dejar en el Lobby)'),
  (null, 'Mayra Gonzalez', '', '', 'CONTACTAR'),
  (null, 'Beatriz Abud', '', '829-451-6470', 'C/Fabio A Mota 12 Torre Tifany apart 16 A'),
  (null, 'Loli Freites', '', '809-545-1442', 'C/Paseo de los Locutores 12, Torre Almaden V apt 401 Casi esq'),
  (null, 'Mayerlin Baquero', 'mayerlin@mayerlinbaquero.com', '809-481-3350', 'C/Pedro Henriquez Urena 131, Torre Pedro Henriquez Urena apt107'),
  (null, 'Ana Ramos', '', '849-858-2626', 'C/ Poncio Sabater #24, Torre Tree Tower Lux apt 5C'),
  (null, 'Carolina Quezada', '', '809-910-6102', ''),
  (null, 'Ariane Morales', '', '809-696-3038', ''),
  (null, 'Ana Vilma Gomez', '', '809-989-6265', 'C/Juan Isidro Ortega #74, edificio ND74 apt 4A, Los Prados'),
  (null, 'Lesky Lugo', '', '829-830-3394', 'C/ Heriberto Nunez #25, Torre Melissa X local 1D.Urb Fernandez'),
  (null, 'Scarlit Rodriguez', '', '829-268-8210', 'C/Pedro Henriquez Urena 135,Torre Tellium II apat 702, Esperilla'),
  (null, 'Mary Sanchez', '', '809-781-5781', 'Av.Los Proceres, frenta a la rotonda. Plaza Bernabe loca BM Cargo'),
  (null, 'Alejandra Abreu', '', '809-918-9120', 'C/Luis F Thomen 110, Torre Ejecutiva Gapo 4 Nivel local 405'),
  (null, 'Alexia Vicini', '', '809-993-5553', 'C/ Caña Dulce 1A , Cucama RD, una casa oficina'),
  (null, 'Emely Fernandez', 'arquitectura@nrdalab.com', '829-718-5523', 'C/ Victor Garrido Puello #14, Local 303'),
  (null, 'Aranza Chalas', '', '829-718-6587', 'C/Prolongacion Sierva de Maria #12,Edif Dona Isabel apat D2 Naco'),
  (null, 'Maria Torres Prida', '', '829-986-4006', ''),
  (null, 'Annabel Dantes Castillo', 'dualdesignrd@gmail.com', '809-705-0110', 'C/Furcy Pichardo #12 Residencial Celeste II, apt 6B. Bella Vista'),
  (null, 'Sheela Parlavecchia', '', '849-581-0625', 'C/ Cesar Nicolas Penson 121, Torre Andrea Alberto 2. La Esperilla'),
  (null, 'Patricia Jimenez', '', '809-481-7682', 'C/RL Sauce#8'),
  (null, 'Maureen Heinsen', '', '809-377-8080', 'Av. Bolivar #197, Torre One Bolivar apt 5C entre Tiradente y Lincoln'),
  (null, 'Carlos Reyes', '', '849-885-0595', ''),
  (null, 'Grace Dominguez', '', '829-856-7197', ''),
  (90, 'Patricia Read', 'patriciareid@gmail.com', '809-299-2002', ''))
insert into public.professionals
  (id, profile_id, number, name, email, phone, notes)
select
  'pro_' || md5('seed-professional:' || s.name),
  'team',
  case
    when s.num is not null and not exists (
      select 1 from public.professionals p
      where p.profile_id = 'team' and p.number = s.num
    ) then s.num
  end,
  s.name,
  s.email,
  s.phone,
  s.notes
from seed s
where not exists (
  select 1 from public.professionals p
  where p.profile_id = 'team'
    and lower(trim(p.name)) = lower(s.name)
);

notify pgrst, 'reload schema';
