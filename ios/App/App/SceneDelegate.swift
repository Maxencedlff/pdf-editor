import UIKit
import Capacitor

class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let windowScene = scene as? UIWindowScene else { return }

        window = UIWindow(windowScene: windowScene)
        window?.rootViewController = EditeurViewController()
        window?.makeKeyAndVisible()

        SceneDelegateProxy.shared.scene(scene, willConnectTo: session, options: connectionOptions)
    }

    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        SceneDelegateProxy.shared.scene(scene, openURLContexts: URLContexts)
    }

    func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
        SceneDelegateProxy.shared.scene(scene, continue: userActivity)
    }
}

/// Seule la page PDF se zoome, par ui.js. Le zoom natif de la WKWebView agrandirait
/// toute l'interface : barres sous l'encoche, dock hors de l'ecran. On le coupe ici, en
/// plus du viewport, que WebKit ne respecte pas dans tous les cas (pincement amorce
/// hors de la page, rebond de zoom).
class EditeurViewController: CAPBridgeViewController {
    private var zoomWatch: NSKeyValueObservation?

    override func capacitorDidLoad() {
        super.capacitorDidLoad()
        guard let scroll = webView?.scrollView else { return }
        scroll.bouncesZoom = false
        scroll.bounces = false
        zoomWatch = scroll.observe(\.zoomScale) { scroll, _ in
            if abs(scroll.zoomScale - 1) > 0.001 { scroll.setZoomScale(1, animated: false) }
        }
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        // WebKit recree le geste de zoom a chaque changement de viewport : on le recoupe.
        webView?.scrollView.pinchGestureRecognizer?.isEnabled = false
    }
}
