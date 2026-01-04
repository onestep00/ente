import "dart:async";

import "package:flutter/gestures.dart";
import "package:flutter/material.dart";
import "package:photos/core/event_bus.dart";
import "package:photos/events/video_preview_state_changed_event.dart";
import "package:photos/generated/l10n.dart";
import "package:photos/l10n/l10n.dart";
import "package:photos/models/preview/preview_item_status.dart";
import "package:photos/services/video_preview_service.dart";
import "package:photos/theme/ente_theme.dart";
import "package:photos/ui/common/loading_widget.dart";
import "package:photos/ui/common/web_page.dart";
import "package:photos/ui/components/buttons/button_widget.dart";
import "package:photos/ui/components/captioned_text_widget.dart";
import "package:photos/ui/components/menu_item_widget/menu_item_widget.dart";
import "package:photos/ui/components/models/button_type.dart";
import "package:photos/ui/components/title_bar_title_widget.dart";
import "package:photos/ui/components/title_bar_widget.dart";
import "package:photos/ui/components/toggle_switch_widget.dart";

const helpUrl =
    "https://ente.io/help/photos/features/utilities/video-streaming#related-faqs";

class VideoStreamingSettingsPage extends StatefulWidget {
  const VideoStreamingSettingsPage({super.key});

  @override
  State<VideoStreamingSettingsPage> createState() =>
      _VideoStreamingSettingsPageState();
}

class _VideoStreamingSettingsPageState
    extends State<VideoStreamingSettingsPage> {
  @override
  void initState() {
    super.initState();
  }

  @override
  void dispose() {
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final hasEnabled = VideoPreviewService.instance.isVideoStreamingEnabled;
    return Scaffold(
      bottomNavigationBar: !hasEnabled
          ? SafeArea(
              child: Padding(
                padding: const EdgeInsets.symmetric(horizontal: 16)
                    .copyWith(bottom: 20),
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    const SizedBox(height: 12),
                    ButtonWidget(
                      buttonType: ButtonType.primary,
                      labelText: context.l10n.enable,
                      onTap: () async {
                        await toggleVideoStreaming();
                      },
                    ),
                  ],
                ),
              ),
            )
          : null,
      appBar: hasEnabled
          ? null
          : PreferredSize(
              preferredSize: const Size.fromHeight(154),
              child: TitleBarWidget(
                reducedExpandedHeight: 16,
                flexibleSpaceTitle: TitleBarTitleWidget(
                  title: AppLocalizations.of(context).videoStreaming,
                ),
                actionIcons: const [],
                isSliver: false,
              ),
            ),
      body: hasEnabled
          ? CustomScrollView(
              primary: false,
              slivers: <Widget>[
                TitleBarWidget(
                  reducedExpandedHeight: 16,
                  flexibleSpaceTitle: TitleBarTitleWidget(
                    title: AppLocalizations.of(context).videoStreaming,
                  ),
                  actionIcons: const [],
                ),
                SliverToBoxAdapter(
                  child: Container(
                    padding: const EdgeInsets.only(left: 16, right: 16),
                    child: Column(
                      children: [
                        Text.rich(
                          TextSpan(
                            children: [
                              TextSpan(
                                text: AppLocalizations.of(context)
                                    .videoStreamingDescriptionLine1,
                              ),
                              const TextSpan(text: " "),
                              TextSpan(
                                text: AppLocalizations.of(context)
                                    .videoStreamingDescriptionLine2,
                              ),
                              const TextSpan(text: " "),
                              TextSpan(
                                text: AppLocalizations.of(context).moreDetails,
                                style: TextStyle(
                                  color: getEnteColorScheme(context).primary500,
                                ),
                                recognizer: TapGestureRecognizer()
                                  ..onTap = openHelp,
                              ),
                            ],
                          ),
                          style: getEnteTextTheme(context).mini.copyWith(
                                color: getEnteColorScheme(context).textMuted,
                              ),
                        ),
                      ],
                    ),
                  ),
                ),
                SliverToBoxAdapter(
                  child: Padding(
                    padding: const EdgeInsets.symmetric(
                      horizontal: 10,
                    ).copyWith(top: 30),
                    child: _getStreamingSettings(context),
                  ),
                ),
              ],
            )
          : Center(
              child: SingleChildScrollView(
                child: Column(
                  children: [
                    Image.asset(
                      "assets/enable-streaming-static.png",
                      height: 160,
                    ),
                    const SizedBox(height: 16),
                    Padding(
                      padding: const EdgeInsets.symmetric(horizontal: 12),
                      child: Text.rich(
                        TextSpan(
                          children: [
                            TextSpan(
                              text: AppLocalizations.of(context)
                                  .videoStreamingDescriptionLine1,
                            ),
                            const TextSpan(text: "\n"),
                            TextSpan(
                              text: AppLocalizations.of(context)
                                  .videoStreamingDescriptionLine2,
                            ),
                            const TextSpan(text: "\n"),
                            TextSpan(
                              text: AppLocalizations.of(context).moreDetails,
                              style: TextStyle(
                                color: getEnteColorScheme(context).primary500,
                              ),
                              recognizer: TapGestureRecognizer()
                                ..onTap = openHelp,
                            ),
                          ],
                        ),
                        style: getEnteTextTheme(context).smallMuted,
                        textAlign: TextAlign.center,
                      ),
                    ),
                    const SizedBox(height: 140),
                  ],
                ),
              ),
            ),
    );
  }

  Future<void> openHelp() async {
    Navigator.of(context).push(
      MaterialPageRoute(
        builder: (BuildContext context) {
          return WebPage(AppLocalizations.of(context).help, helpUrl);
        },
      ),
    ).ignore();
  }

  Future<void> toggleVideoStreaming() async {
    final isEnabled = VideoPreviewService.instance.isVideoStreamingEnabled;

    await VideoPreviewService.instance.setIsVideoStreamingEnabled(!isEnabled);
    if (!mounted) return;
    setState(() {});
  }

  Widget _getStreamingSettings(BuildContext context) {
    final hasEnabled = VideoPreviewService.instance.isVideoStreamingEnabled;
    final colorScheme = getEnteColorScheme(context);

    return Column(
      children: [
        MenuItemWidget(
          captionedTextWidget: CaptionedTextWidget(
            title: AppLocalizations.of(context).enabled,
          ),
          trailingWidget: ToggleSwitchWidget(
            value: () => hasEnabled,
            onChanged: () async {
              await toggleVideoStreaming();
            },
          ),
          singleBorderRadius: 8,
          alignCaptionedTextToLeft: true,
          menuItemColor: colorScheme.fillFaint,
        ),
        const SizedBox(height: 8),
        const VideoStreamingStatusWidget(),
      ],
    );
  }
}

class VideoStreamingStatusWidget extends StatefulWidget {
  const VideoStreamingStatusWidget({super.key});

  @override
  State<VideoStreamingStatusWidget> createState() =>
      VideoStreamingStatusWidgetState();
}

class VideoStreamingStatusWidgetState
    extends State<VideoStreamingStatusWidget> {
  double? _netProcessed;
  StreamSubscription? _subscription;
  Timer? _progressTimer;
  int _queueTotal = 0;
  int _queueCurrent = 0;
  List<String> _encodingSummary = const [];
  double? _encodingProgress;

  @override
  void initState() {
    super.initState();
    init();
    _subscription =
        Bus.instance.on<VideoPreviewStateChangedEvent>().listen((event) {
      final status = event.status;
      _refreshQueueStatus();

      if (status == PreviewItemStatus.uploaded) {
        init();
      }
    });
    unawaited(_updateEncodingProgress());
    _progressTimer = Timer.periodic(const Duration(seconds: 5), (_) {
      unawaited(_updateEncodingProgress());
    });
  }

  Future<void> init() async {
    final netProcessed = await VideoPreviewService.instance.getStatus();
    if (!mounted) return;
    setState(() {
      _netProcessed = netProcessed;
      _syncQueueStatus();
    });
  }

  void _syncQueueStatus() {
    final queueProgress = VideoPreviewService.instance.getQueueProgress();
    _queueTotal = queueProgress.total;
    _queueCurrent = queueProgress.current;
    _encodingSummary = VideoPreviewService.instance.getCurrentEncodingSummary();
    if (_encodingSummary.isEmpty) {
      _encodingProgress = null;
    }
  }

  void _refreshQueueStatus() {
    if (!mounted) return;
    setState(_syncQueueStatus);
  }

  @override
  void dispose() {
    _subscription?.cancel();
    _progressTimer?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final colorScheme = getEnteColorScheme(context);
    final bool hasQueue = _queueTotal > 0;
    final bool hasEncodingSummary = _encodingSummary.isNotEmpty;
    return Column(
      children: [
        if (_netProcessed != null)
          Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              MenuItemWidget(
                captionedTextWidget: CaptionedTextWidget(
                  title: AppLocalizations.of(context).processed,
                ),
                trailingWidget: Text(
                  _netProcessed == 0
                      ? '0%'
                      : '${(_netProcessed! * 100.0).toStringAsFixed(2)}%',
                  style: Theme.of(context).textTheme.bodySmall,
                ),
                singleBorderRadius: 8,
                alignCaptionedTextToLeft: true,
                isGestureDetectorDisabled: true,
                key: ValueKey("processed_items_" + _netProcessed.toString()),
                menuItemColor: colorScheme.fillFaint,
              ),
              if (hasQueue) ...[
                const SizedBox(height: 8),
                MenuItemWidget(
                  captionedTextWidget: CaptionedTextWidget(
                    title: AppLocalizations.of(context).processingVideos,
                  ),
                  trailingWidget: Text(
                    _queueCurrent > 0
                        ? '$_queueCurrent/$_queueTotal'
                        : AppLocalizations.of(context).queued,
                    style: Theme.of(context).textTheme.bodySmall,
                  ),
                  singleBorderRadius: 8,
                  alignCaptionedTextToLeft: true,
                  isGestureDetectorDisabled: true,
                  menuItemColor: colorScheme.fillFaint,
                ),
              ],
              if (hasEncodingSummary) ...[
                const SizedBox(height: 8),
                MenuItemWidget(
                  captionedTextWidget: _buildEncodingSummary(context),
                  singleBorderRadius: 8,
                  alignCaptionedTextToLeft: true,
                  isGestureDetectorDisabled: true,
                  menuItemColor: colorScheme.fillFaint,
                ),
              ],
              const SizedBox(height: 12),
              Padding(
                padding: const EdgeInsets.symmetric(horizontal: 8.0),
                child: Text(
                  AppLocalizations.of(context).videoStreamingNote,
                  style: getEnteTextTheme(context).mini.copyWith(
                        color: getEnteColorScheme(context).textMuted,
                      ),
                ),
              ),
            ],
          )
        else
          const EnteLoadingWidget(),
      ],
    );
  }

  Widget _buildEncodingSummary(BuildContext context) {
    final textTheme = getEnteTextTheme(context);
    final mutedColor = getEnteColorScheme(context).textMuted;
    final progressValue = _encodingProgress;
    final progressLine = progressValue == null
        ? null
        : "${AppLocalizations.of(context).processing}: ${(progressValue * 100).toStringAsFixed(0)}%";
    return Flexible(
      child: Padding(
        padding: const EdgeInsets.symmetric(vertical: 10, horizontal: 2),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              AppLocalizations.of(context).streamDetails,
              style: textTheme.body,
            ),
            const SizedBox(height: 6),
            if (progressLine != null)
              Padding(
                padding: const EdgeInsets.only(bottom: 4),
                child: Text(
                  progressLine,
                  style: textTheme.mini.copyWith(color: mutedColor),
                ),
              ),
            ..._encodingSummary.map(
              (line) => Padding(
                padding: const EdgeInsets.only(bottom: 4),
                child: Text(
                  line,
                  style: textTheme.mini.copyWith(color: mutedColor),
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }

  Future<void> _updateEncodingProgress() async {
    final progress =
        await VideoPreviewService.instance.getCurrentEncodingProgress();
    if (!mounted) return;

    final summary = VideoPreviewService.instance.getCurrentEncodingSummary();
    final clamped =
        progress == null ? null : progress.clamp(0.0, 1.0) as double;
    final summaryChanged = summary.join("\n") != _encodingSummary.join("\n");
    final progressChanged = switch ((clamped, _encodingProgress)) {
      (null, null) => false,
      (null, _) => true,
      (_, null) => true,
      _ => (clamped! - _encodingProgress!).abs() >= 0.01,
    };
    if (!summaryChanged && !progressChanged) return;
    setState(() {
      _encodingSummary = summary;
      _encodingProgress = clamped;
    });
  }
}
