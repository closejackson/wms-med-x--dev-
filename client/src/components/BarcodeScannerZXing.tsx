import { useEffect, useRef, useState, useCallback } from "react";
import { BrowserMultiFormatReader, NotFoundException, BarcodeFormat, DecodeHintType } from "@zxing/library";
import { Button } from "./ui/button";
import { Camera, X, Zap, ZapOff, Check, AlertCircle, SwitchCamera } from "lucide-react";
import { cn } from "@/lib/utils";

interface BarcodeScannerZXingProps {
  onScan: (code: string) => void;
  onClose: () => void;
  /** Otimizado para código de barras linear longo (NF-e Code 128) */
  linearBarcode?: boolean;
}

export function BarcodeScannerZXing({
  onScan,
  onClose,
  linearBarcode = false,
}: BarcodeScannerZXingProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const readerRef = useRef<BrowserMultiFormatReader | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const lastScanTimeRef = useRef<number>(0);

  const [isScanning, setIsScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [flashEnabled, setFlashEnabled] = useState(false);
  const [facingMode, setFacingMode] = useState<"environment" | "user">("environment");
  const [scanSuccess, setScanSuccess] = useState(false);
  const [lastScannedCode, setLastScannedCode] = useState<string>("");
  const [successCount, setSuccessCount] = useState(0);

  const vibrate = (pattern: number | number[]) => {
    if ("vibrate" in navigator) navigator.vibrate(pattern);
  };

  const stopScanner = useCallback(async () => {
    if (readerRef.current) {
      readerRef.current.reset();
      readerRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    setIsScanning(false);
  }, []);

  const startScanner = useCallback(async () => {
    try {
      setError(null);

      // Configurar hints para formatos relevantes
      const hints = new Map();
      const formats = linearBarcode
        ? [
            BarcodeFormat.CODE_128,
            BarcodeFormat.CODE_39,
            BarcodeFormat.ITF,
            BarcodeFormat.EAN_13,
          ]
        : [
            BarcodeFormat.CODE_128,
            BarcodeFormat.CODE_39,
            BarcodeFormat.QR_CODE,
            BarcodeFormat.EAN_13,
            BarcodeFormat.EAN_8,
            BarcodeFormat.DATA_MATRIX,
            BarcodeFormat.ITF,
          ];
      hints.set(DecodeHintType.POSSIBLE_FORMATS, formats);
      hints.set(DecodeHintType.TRY_HARDER, true);

      const reader = new BrowserMultiFormatReader(hints, 100);
      readerRef.current = reader;

      // Obter stream da câmera
      const constraints: MediaStreamConstraints = {
        video: {
          facingMode,
          width: { ideal: 1920 },
          height: { ideal: 1080 },
        },
      };
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      streamRef.current = stream;

      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
        setIsScanning(true);

        // Decodificar continuamente
        const decode = async () => {
          if (!readerRef.current || !videoRef.current) return;
          try {
            const result = await readerRef.current.decodeFromVideoElement(videoRef.current);
            const now = Date.now();
            if (now - lastScanTimeRef.current < 2000) {
              requestAnimationFrame(decode);
              return;
            }
            lastScanTimeRef.current = now;

            const text = result.getText();
            setLastScannedCode(text);
            setSuccessCount((p) => p + 1);
            setScanSuccess(true);
            vibrate([50, 100, 50]);

            setTimeout(() => {
              setScanSuccess(false);
              onScan(text);
              stopScanner();
            }, 600);
          } catch (err) {
            if (err instanceof NotFoundException) {
              // Normal — nenhum código no frame
              requestAnimationFrame(decode);
            } else {
              // Erro real
              console.error("ZXing decode error:", err);
              requestAnimationFrame(decode);
            }
          }
        };
        decode();
      }
    } catch (err: any) {
      console.error("Erro ao iniciar câmera:", err);
      setError(err.message || "Erro ao acessar câmera. Verifique as permissões.");
      vibrate(200);
    }
  }, [facingMode, linearBarcode, onScan, stopScanner]);

  useEffect(() => {
    startScanner();
    return () => {
      stopScanner();
    };
  }, [facingMode]);

  const toggleFlash = async () => {
    if (!streamRef.current) return;
    const track = streamRef.current.getVideoTracks()[0];
    const caps = track.getCapabilities() as any;
    if (!caps.torch) return;
    const newState = !flashEnabled;
    await track.applyConstraints({ advanced: [{ torch: newState }] } as any);
    setFlashEnabled(newState);
  };

  const handleCameraSwitch = async () => {
    await stopScanner();
    setFacingMode((prev) => (prev === "environment" ? "user" : "environment"));
  };

  const handleClose = () => {
    stopScanner();
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 bg-black flex flex-col">
      {/* Header */}
      <div className="w-full px-4 py-3 flex items-center justify-between text-white bg-black/60 backdrop-blur-sm">
        <div className="flex items-center gap-2">
          <Camera className="w-5 h-5" />
          <div>
            <h2 className="text-base font-semibold">
              {linearBarcode ? "Leitura de NF-e" : "Scanner de Código"}
            </h2>
            <p className="text-xs text-white/60">
              {successCount > 0 ? `${successCount} leitura(s)` : "Aguardando leitura..."}
            </p>
          </div>
        </div>
        <Button
          variant="ghost"
          size="icon"
          onClick={handleClose}
          className="text-white hover:bg-white/10 h-10 w-10"
        >
          <X className="w-5 h-5" />
        </Button>
      </div>

      {/* Video Area */}
      <div className="flex-1 relative flex items-center justify-center overflow-hidden bg-black">
        <video
          ref={videoRef}
          className="w-full h-full object-cover"
          muted
          playsInline
          autoPlay
        />

        {/* Overlay de guia */}
        {isScanning && !scanSuccess && (
          <div className="absolute inset-0 pointer-events-none flex items-center justify-center">
            {linearBarcode ? (
              /* Guia retangular para código de barras linear */
              <div className="relative" style={{ width: "85vw", maxWidth: 420, height: 90 }}>
                <div className="absolute top-0 left-0 w-10 h-10 border-t-4 border-l-4 border-green-400 rounded-tl-lg" />
                <div className="absolute top-0 right-0 w-10 h-10 border-t-4 border-r-4 border-green-400 rounded-tr-lg" />
                <div className="absolute bottom-0 left-0 w-10 h-10 border-b-4 border-l-4 border-green-400 rounded-bl-lg" />
                <div className="absolute bottom-0 right-0 w-10 h-10 border-b-4 border-r-4 border-green-400 rounded-br-lg" />
                {/* Linha de scan */}
                <div className="absolute inset-0 overflow-hidden">
                  <div className="absolute w-full h-0.5 bg-gradient-to-r from-transparent via-green-400 to-transparent animate-scan-line" />
                </div>
                <p className="absolute -bottom-7 left-0 right-0 text-center text-xs text-yellow-300">
                  Centralize o código de barras na área verde
                </p>
              </div>
            ) : (
              /* Guia quadrado para QR/outros */
              <div className="relative w-64 h-64">
                <div className="absolute top-0 left-0 w-12 h-12 border-t-4 border-l-4 border-green-400 rounded-tl-lg" />
                <div className="absolute top-0 right-0 w-12 h-12 border-t-4 border-r-4 border-green-400 rounded-tr-lg" />
                <div className="absolute bottom-0 left-0 w-12 h-12 border-b-4 border-l-4 border-green-400 rounded-bl-lg" />
                <div className="absolute bottom-0 right-0 w-12 h-12 border-b-4 border-r-4 border-green-400 rounded-br-lg" />
                <div className="absolute inset-0 overflow-hidden">
                  <div className="absolute w-full h-1 bg-gradient-to-r from-transparent via-green-400 to-transparent animate-scan-line" />
                </div>
              </div>
            )}
          </div>
        )}

        {/* Feedback de sucesso */}
        {scanSuccess && (
          <div className="absolute inset-0 flex items-center justify-center bg-green-500/20 backdrop-blur-sm">
            <div className="bg-green-500 rounded-full p-6">
              <Check className="w-16 h-16 text-white" strokeWidth={3} />
            </div>
          </div>
        )}

        {/* Erro de câmera */}
        {error && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 bg-black/80 px-6 text-center">
            <AlertCircle className="w-12 h-12 text-red-400" />
            <p className="text-white text-sm">{error}</p>
            <Button onClick={startScanner} className="mt-2">
              Tentar novamente
            </Button>
          </div>
        )}
      </div>

      {/* Status */}
      <div className="w-full px-4 py-2 text-center text-white bg-black/60 backdrop-blur-sm">
        {isScanning ? (
          <div className="space-y-1">
            <p className="text-sm">
              {linearBarcode
                ? "Aponte para o código de barras da NF-e"
                : "Posicione o código dentro da área marcada"}
            </p>
            {lastScannedCode && (
              <div className="text-xs text-green-400 font-mono bg-black/30 rounded px-3 py-1 inline-block truncate max-w-full">
                {lastScannedCode}
              </div>
            )}
          </div>
        ) : !error ? (
          <p className="text-sm text-white/60">Iniciando câmera...</p>
        ) : null}
      </div>

      {/* Controles */}
      <div className="w-full px-4 py-4 bg-black/80 backdrop-blur-sm space-y-3">
        <div className="flex gap-3 max-w-md mx-auto">
          <Button
            variant="outline"
            size="lg"
            onClick={toggleFlash}
            disabled={!isScanning}
            className={cn(
              "flex-1 h-12 border-white/20 text-white hover:bg-white/10",
              flashEnabled && "bg-yellow-500/20 border-yellow-500"
            )}
          >
            {flashEnabled ? (
              <><Zap className="w-4 h-4 mr-2 text-yellow-400" />Flash Ligado</>
            ) : (
              <><ZapOff className="w-4 h-4 mr-2" />Flash</>
            )}
          </Button>
          <Button
            variant="outline"
            size="lg"
            onClick={handleCameraSwitch}
            disabled={!isScanning}
            className="flex-1 h-12 border-white/20 text-white hover:bg-white/10"
          >
            <SwitchCamera className="w-4 h-4 mr-2" />
            Trocar Câmera
          </Button>
        </div>
        <Button
          variant="outline"
          onClick={handleClose}
          className="w-full h-11 bg-white/10 text-white border-white/20 hover:bg-white/20 max-w-md mx-auto block"
        >
          Cancelar e Digitar Manualmente
        </Button>
      </div>

      <div className="w-full px-4 pb-2 text-center">
        <p className="text-xs text-white/30">
          {linearBarcode ? "Otimizado para NF-e (Code 128 / ZXing)" : "QR Code, Code 128, EAN, Data Matrix"}
        </p>
      </div>
    </div>
  );
}
