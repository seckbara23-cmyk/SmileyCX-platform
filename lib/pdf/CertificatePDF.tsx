import { Document, Page, Text, View, StyleSheet, Svg, Path, Circle, Line, Rect } from '@react-pdf/renderer'

interface Props {
  learnerName: string
  courseTitle: string
  certNumber: string
  issuedAt: string
}

function formatDateFR(dateStr: string) {
  return new Intl.DateTimeFormat('fr-FR', { dateStyle: 'long' }).format(new Date(dateStr))
}

const PRIMARY = '#4a6de5'
const AMBER   = '#f59e0b'
const GRAY    = '#6b7280'
const DARK    = '#111827'
const LIGHT   = '#6b7280'

const s = StyleSheet.create({
  page: {
    backgroundColor: '#fafbff',
    fontFamily: 'Helvetica',
    position: 'relative',
  },
  // Outer border drawn as absolute SVG layer
  body: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 60,
    paddingVertical: 36,
  },
  brand: {
    fontSize: 18,
    fontFamily: 'Helvetica-Bold',
    color: PRIMARY,
    marginBottom: 2,
  },
  brandCX: { color: AMBER },
  brandAcademy: { color: GRAY, fontSize: 11, fontFamily: 'Helvetica' },
  divider: { width: 60, height: 2, backgroundColor: PRIMARY, marginVertical: 5, alignSelf: 'center' },
  titleLabel: {
    fontSize: 7,
    color: GRAY,
    letterSpacing: 2,
    textTransform: 'uppercase',
    marginBottom: 18,
    textAlign: 'center',
  },
  awardedTo: { fontSize: 9, color: GRAY, marginBottom: 5, textAlign: 'center' },
  name: {
    fontSize: 30,
    fontFamily: 'Helvetica-Bold',
    color: DARK,
    textAlign: 'center',
    marginBottom: 4,
  },
  nameLine: { width: 140, height: 1, backgroundColor: '#e5e7eb', marginBottom: 14, alignSelf: 'center' },
  forCompleting: { fontSize: 9, color: GRAY, marginBottom: 5, textAlign: 'center' },
  course: {
    fontSize: 15,
    fontFamily: 'Helvetica-Bold',
    color: PRIMARY,
    textAlign: 'center',
    maxWidth: 340,
    marginBottom: 24,
  },
  sigRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 80,
    paddingTop: 14,
    borderTopWidth: 1,
    borderTopColor: '#e5e7eb',
    width: '100%',
    marginBottom: 18,
  },
  sigBlock: { alignItems: 'center' },
  sigLine: { width: 90, height: 1, backgroundColor: '#d1d5db', marginBottom: 4 },
  sigName: { fontSize: 7, fontFamily: 'Helvetica-Bold', color: '#374151', textAlign: 'center' },
  sigRole: { fontSize: 6, color: '#9ca3af', marginTop: 1, textAlign: 'center' },
  footer: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingTop: 10,
    borderTopWidth: 1,
    borderTopColor: '#f3f4f6',
    width: '100%',
  },
  footerText: { fontSize: 7, color: '#9ca3af' },
  certNum: { fontSize: 7, fontFamily: 'Courier', color: PRIMARY },
})

function MedalSvg() {
  return (
    <Svg width="60" height="60" viewBox="0 0 60 60" style={{ marginBottom: 12 }}>
      <Circle cx="30" cy="30" r="28" fill={AMBER} />
      <Circle cx="30" cy="30" r="24" fill="none" stroke="rgba(255,255,255,0.3)" strokeWidth="1" />
      <Path d="M30 14 L33 24 L44 24 L35 31 L38 42 L30 36 L22 42 L25 31 L16 24 L27 24 Z" fill="white" />
    </Svg>
  )
}

export function CertificatePDFDocument({ learnerName, courseTitle, certNumber, issuedAt }: Props) {
  return (
    <Document title={`Certificat — ${learnerName}`} author="SmileyCX Academy">
      <Page size="A4" orientation="landscape" style={s.page}>

        {/* Outer border frame */}
        <Svg style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%' }} viewBox="0 0 842 595">
          <Rect x="12" y="12" width="818" height="571" rx="10" ry="10"
            stroke={PRIMARY} strokeWidth="2.5" fill="none" />
          <Rect x="20" y="20" width="802" height="555" rx="7" ry="7"
            stroke={PRIMARY} strokeWidth="0.5" strokeOpacity="0.25" fill="none" />
          {/* Corner ornaments */}
          <Path d="M12 60 L12 12 L60 12" stroke={PRIMARY} strokeWidth="3" fill="none" strokeLinecap="round" />
          <Path d="M12 40 L12 12 L40 12" stroke={AMBER} strokeWidth="1.5" strokeOpacity="0.6" fill="none" strokeLinecap="round" />
          <Circle cx="12" cy="12" r="3" fill={AMBER} />
          <Path d="M830 60 L830 12 L782 12" stroke={PRIMARY} strokeWidth="3" fill="none" strokeLinecap="round" />
          <Path d="M830 40 L830 12 L802 12" stroke={AMBER} strokeWidth="1.5" strokeOpacity="0.6" fill="none" strokeLinecap="round" />
          <Circle cx="830" cy="12" r="3" fill={AMBER} />
          <Path d="M12 535 L12 583 L60 583" stroke={PRIMARY} strokeWidth="3" fill="none" strokeLinecap="round" />
          <Path d="M12 555 L12 583 L40 583" stroke={AMBER} strokeWidth="1.5" strokeOpacity="0.6" fill="none" strokeLinecap="round" />
          <Circle cx="12" cy="583" r="3" fill={AMBER} />
          <Path d="M830 535 L830 583 L782 583" stroke={PRIMARY} strokeWidth="3" fill="none" strokeLinecap="round" />
          <Path d="M830 555 L830 583 L802 583" stroke={AMBER} strokeWidth="1.5" strokeOpacity="0.6" fill="none" strokeLinecap="round" />
          <Circle cx="830" cy="583" r="3" fill={AMBER} />
        </Svg>

        <View style={s.body}>
          {/* Brand */}
          <Text style={s.brand}>
            <Text>Smiley</Text>
            <Text style={s.brandCX}>CX</Text>
            <Text style={s.brandAcademy}> Academy</Text>
          </Text>
          <View style={s.divider} />
          <Text style={s.titleLabel}>Certificat de Réussite</Text>

          {/* Medal */}
          <MedalSvg />

          {/* Recipient */}
          <Text style={s.awardedTo}>Ce certificat est décerné à</Text>
          <Text style={s.name}>{learnerName}</Text>
          <View style={s.nameLine} />
          <Text style={s.forCompleting}>pour avoir complété avec succès la formation</Text>
          <Text style={s.course}>{courseTitle}</Text>

          {/* Signatures */}
          <View style={s.sigRow}>
            <View style={s.sigBlock}>
              <View style={s.sigLine} />
              <Text style={s.sigName}>SmileyCX Consulting</Text>
              <Text style={s.sigRole}>Organisation</Text>
            </View>
            <View style={s.sigBlock}>
              <View style={s.sigLine} />
              <Text style={s.sigName}>Directrice de Formation</Text>
              <Text style={s.sigRole}>Responsable pédagogique</Text>
            </View>
          </View>

          {/* Footer */}
          <View style={s.footer}>
            <Text style={s.footerText}>Délivré le {formatDateFR(issuedAt)}</Text>
            <Text style={s.certNum}>N° {certNumber}</Text>
          </View>
        </View>
      </Page>
    </Document>
  )
}
